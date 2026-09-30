import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const githubAuthorize = 'https://github.com/login/oauth/authorize'
const githubToken = 'https://github.com/login/oauth/access_token'
const githubGraphql = 'https://api.github.com/graphql'
const stateLifetimeMs = 10 * 60 * 1000
const maxRequestBytes = 32 * 1024
const mime = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
}

const random = () => randomBytes(32).toString('base64url')
const normalizeRepo = (input) => {
  const match = input.match(/^(?:https:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/)
  return match ? `${match[1]}/${match[2]}` : ''
}
const cookie = (name, value, maxAge) =>
  `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
const failure = (status, message) => json({ error: message }, status)
const readCookies = (request) =>
  Object.fromEntries(
    (request.headers.get('cookie') ?? '')
      .split(';')
      .map((part) => part.trim().split('='))
      .filter(([name, value]) => name && value),
  )

export function createLocalHandler({ clientId, clientSecret, origin, distDir, fetchImpl = fetch }) {
  if (!clientId || !clientSecret) throw new Error('GitHub App client ID and secret are required.')
  const base = new URL(origin)
  if (base.hostname !== '127.0.0.1' || base.protocol !== 'http:') {
    throw new Error('Local auth must use an http://127.0.0.1 origin.')
  }
  const states = new Map()
  const sessions = new Map()
  const callback = new URL('/auth/callback', base).toString()
  const assetRoot = resolve(distDir)

  const sessionStatus = (cookies) => {
    const session = sessions.get(cookies.atlas_session)
    if (session && session.expiresAt <= Date.now()) sessions.delete(cookies.atlas_session)
    return json({
      available: true,
      authenticated: Boolean(session && session.expiresAt > Date.now()),
    })
  }

  const beginSignIn = (url) => {
    for (const [key, entry] of states) {
      if (entry.expiresAt <= Date.now()) states.delete(key)
    }
    const state = random()
    const verifier = random()
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const repo = normalizeRepo(url.searchParams.get('repo') ?? '')
    states.set(state, { verifier, repo, expiresAt: Date.now() + stateLifetimeMs })
    const target = new URL(githubAuthorize)
    target.searchParams.set('client_id', clientId)
    target.searchParams.set('redirect_uri', callback)
    target.searchParams.set('state', state)
    target.searchParams.set('code_challenge', challenge)
    target.searchParams.set('code_challenge_method', 'S256')
    return new Response(null, {
      status: 302,
      headers: {
        Location: target.toString(),
        'Set-Cookie': cookie('atlas_oauth_state', state, 600),
        'Cache-Control': 'no-store',
      },
    })
  }

  const finishSignIn = async (url, cookies) => {
    const state = url.searchParams.get('state') ?? ''
    const entry = states.get(state)
    states.delete(state)
    if (
      !entry ||
      entry.expiresAt <= Date.now() ||
      cookies.atlas_oauth_state !== state ||
      !url.searchParams.get('code')
    ) {
      return failure(400, 'GitHub sign-in could not be verified. Start again from Issue Atlas.')
    }
    const exchange = await fetchImpl(githubToken, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code: url.searchParams.get('code'),
        redirect_uri: callback,
        code_verifier: entry.verifier,
      }),
    })
    const result = await exchange.json().catch(() => ({}))
    if (!exchange.ok || typeof result.access_token !== 'string') {
      return failure(502, 'GitHub sign-in failed. Start again from Issue Atlas.')
    }
    const sessionId = random()
    const lifetime = Math.min(Number(result.expires_in) || 8 * 3600, 8 * 3600)
    sessions.set(sessionId, { token: result.access_token, expiresAt: Date.now() + lifetime * 1000 })
    const destination = new URL('/', base)
    if (entry.repo) destination.searchParams.set('repo', entry.repo)
    const headers = new Headers({ Location: destination.toString(), 'Cache-Control': 'no-store' })
    headers.append('Set-Cookie', cookie('atlas_oauth_state', '', 0))
    headers.append('Set-Cookie', cookie('atlas_session', sessionId, lifetime))
    return new Response(null, { status: 302, headers })
  }

  const proxyGraphql = async (request, cookies) => {
    const session = sessions.get(cookies.atlas_session)
    if (!session || session.expiresAt <= Date.now()) return failure(401, 'Sign in to GitHub again.')
    const body = await request.text()
    if (body.length > maxRequestBytes) return failure(413, 'GraphQL request is too large.')
    let payload
    try {
      payload = JSON.parse(body)
    } catch {
      return failure(400, 'Invalid GraphQL request.')
    }
    if (
      typeof payload.query !== 'string' ||
      typeof payload.variables !== 'object' ||
      payload.variables === null
    ) {
      return failure(400, 'Invalid GraphQL request.')
    }
    const response = await fetchImpl(githubGraphql, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${session.token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2026-03-10',
      },
      body: JSON.stringify(payload),
    })
    if (!response.ok)
      return failure(response.status === 401 ? 401 : 502, 'GitHub could not return issue data.')
    return new Response(response.body, {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    })
  }

  const serveAsset = async (pathname) => {
    const relative =
      pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '')
    const file = resolve(assetRoot, relative)
    if (file !== assetRoot && !file.startsWith(`${assetRoot}${sep}`))
      return failure(404, 'Not found.')
    try {
      const data = await readFile(file)
      return new Response(data, {
        headers: {
          'Content-Type': mime[extname(file)] ?? 'application/octet-stream',
          'Cache-Control': 'no-store',
        },
      })
    } catch {
      return failure(404, 'Not found.')
    }
  }

  return async function handle(request) {
    const url = new URL(request.url)
    const cookies = readCookies(request)
    if (request.method === 'GET') {
      if (url.pathname === '/auth/session') return sessionStatus(cookies)
      if (url.pathname === '/auth/start') return beginSignIn(url)
      if (url.pathname === '/auth/callback') return finishSignIn(url, cookies)
      return serveAsset(url.pathname)
    }
    if (request.method !== 'POST') return failure(405, 'Method not allowed.')
    if (request.headers.get('origin') !== base.origin)
      return failure(403, 'Invalid request origin.')
    if (url.pathname === '/api/graphql') return proxyGraphql(request, cookies)
    if (url.pathname === '/auth/logout') {
      sessions.delete(cookies.atlas_session)
      return new Response(null, {
        status: 204,
        headers: { 'Set-Cookie': cookie('atlas_session', '', 0), 'Cache-Control': 'no-store' },
      })
    }
    return failure(404, 'Not found.')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8769)
  const origin = `http://127.0.0.1:${port}`
  const handler = createLocalHandler({
    clientId: process.env.GITHUB_APP_CLIENT_ID,
    clientSecret: process.env.GITHUB_APP_CLIENT_SECRET,
    origin,
    distDir: resolve(dirname(fileURLToPath(import.meta.url)), '../dist'),
  })
  createServer(async (incoming, outgoing) => {
    try {
      const chunks = []
      for await (const chunk of incoming) {
        chunks.push(chunk)
        if (Buffer.concat(chunks).length > maxRequestBytes) {
          outgoing.writeHead(413).end()
          return
        }
      }
      const request = new Request(new URL(incoming.url, origin), {
        method: incoming.method,
        headers: incoming.headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      })
      const response = await handler(request)
      const headers = Object.fromEntries(response.headers)
      const setCookies = response.headers.getSetCookie()
      if (setCookies.length) headers['set-cookie'] = setCookies
      outgoing.writeHead(response.status, headers)
      outgoing.end(Buffer.from(await response.arrayBuffer()))
    } catch {
      outgoing.writeHead(500, { 'Content-Type': 'text/plain' }).end('Local server error.')
    }
  }).listen(port, '127.0.0.1', () => console.info(`Issue Atlas: ${origin}`))
}
