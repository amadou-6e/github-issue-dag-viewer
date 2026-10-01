import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ISSUE_DETAILS_QUERY, REPOSITORY_PAGE_QUERY } from '../src/github/queries.mjs'

const maxRequestBytes = 32 * 1024
const maxOutputBytes = 24 * 1024 * 1024
const mime = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
}
const queries = {
  repository: REPOSITORY_PAGE_QUERY,
  issue: ISSUE_DETAILS_QUERY,
}
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
const failure = (status, message) => json({ error: message }, status)
const validName = (value) => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value)

export function runGhCommand(args, input = '') {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn('gh', args, {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const chunks = []
    let outputBytes = 0
    const timer = setTimeout(() => child.kill(), 30_000)
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.length
      if (outputBytes > maxOutputBytes) child.kill()
      else chunks.push(chunk)
    })
    child.stderr.resume()
    child.stdin.on('error', () => {})
    child.on('error', (error) => {
      clearTimeout(timer)
      rejectPromise(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0 || outputBytes > maxOutputBytes) {
        rejectPromise(new Error('gh command failed.'))
        return
      }
      resolvePromise(Buffer.concat(chunks).toString('utf8'))
    })
    child.stdin.end(input)
  })
}

export function createLocalHandler({ origin, distDir, ghRunner = runGhCommand }) {
  const base = new URL(origin)
  if (base.hostname !== '127.0.0.1' || base.protocol !== 'http:') {
    throw new Error('The gh bridge must use an http://127.0.0.1 origin.')
  }
  const assetRoot = resolve(distDir)

  const sessionStatus = async () => {
    try {
      await ghRunner(['auth', 'status', '--hostname', 'github.com'])
      return json({ available: true, authenticated: true })
    } catch {
      return json({ available: true, authenticated: false })
    }
  }

  const proxyGraphql = async (request) => {
    let payload
    try {
      payload = await request.json()
    } catch {
      return failure(400, 'Invalid GraphQL request.')
    }
    const query =
      payload?.operation === 'repository'
        ? queries.repository
        : payload?.operation === 'issue'
          ? queries.issue
          : null
    const variables = payload?.variables
    if (
      !query ||
      typeof variables !== 'object' ||
      variables === null ||
      !validName(variables.owner) ||
      !validName(variables.name) ||
      (payload.operation === 'repository' &&
        variables.cursor !== null &&
        (typeof variables.cursor !== 'string' || variables.cursor.length > 500)) ||
      (payload.operation === 'issue' &&
        (!Number.isSafeInteger(variables.number) || variables.number < 1))
    ) {
      return failure(400, 'Invalid GraphQL request.')
    }
    try {
      const output = await ghRunner(
        ['api', 'graphql', '--input', '-'],
        JSON.stringify({ query, variables }),
      )
      return json(JSON.parse(output))
    } catch {
      return failure(502, 'gh could not return issue data. Check gh auth status.')
    }
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
    if (request.method === 'GET') {
      if (url.pathname === '/auth/session') return sessionStatus()
      return serveAsset(url.pathname)
    }
    if (request.method !== 'POST') return failure(405, 'Method not allowed.')
    if (request.headers.get('origin') !== base.origin)
      return failure(403, 'Invalid request origin.')
    if (url.pathname === '/api/graphql') return proxyGraphql(request)
    return failure(404, 'Not found.')
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8769)
  const origin = `http://127.0.0.1:${port}`
  const handler = createLocalHandler({
    origin,
    distDir: resolve(dirname(fileURLToPath(import.meta.url)), '../dist'),
  })
  createServer(async (incoming, outgoing) => {
    try {
      if (incoming.headers.host !== new URL(origin).host) {
        outgoing.writeHead(403).end()
        return
      }
      const chunks = []
      let inputBytes = 0
      for await (const chunk of incoming) {
        inputBytes += chunk.length
        if (inputBytes > maxRequestBytes) {
          outgoing.writeHead(413).end()
          return
        }
        chunks.push(chunk)
      }
      const request = new Request(new URL(incoming.url, origin), {
        method: incoming.method,
        headers: incoming.headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
      })
      const response = await handler(request)
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      outgoing.end(Buffer.from(await response.arrayBuffer()))
    } catch {
      outgoing.writeHead(500, { 'Content-Type': 'text/plain' }).end('Local server error.')
    }
  }).listen(port, '127.0.0.1', () => console.info(`Issue Atlas: ${origin}`))
}
