import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createLocalHandler } from './local.mjs'

const origin = 'http://127.0.0.1:8769'
const makeHandler = (fetchImpl) =>
  createLocalHandler({
    clientId: 'client-id',
    clientSecret: 'server-secret',
    origin,
    distDir: '.',
    fetchImpl,
  })

test('GitHub sign-in uses state and PKCE, then proxies GraphQL without exposing the token', async () => {
  const requests = []
  const handler = makeHandler(async (url, options) => {
    requests.push({ url, options })
    if (url.includes('access_token')) {
      return Response.json({ access_token: 'private-token', expires_in: 3600 })
    }
    return Response.json({ data: { repository: { nameWithOwner: 'owner/repo' } } })
  })
  const start = await handler(new Request(`${origin}/auth/start?repo=owner%2Frepo`))
  assert.equal(start.status, 302)
  const authorize = new URL(start.headers.get('location'))
  assert.equal(authorize.origin, 'https://github.com')
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256')
  assert.ok(authorize.searchParams.get('code_challenge'))
  const state = authorize.searchParams.get('state')
  const stateCookie = start.headers.get('set-cookie').split(';')[0]

  const rejected = await handler(new Request(`${origin}/auth/callback?code=test&state=${state}`))
  assert.equal(rejected.status, 400)
  assert.equal(requests.length, 0)

  const fresh = await handler(new Request(`${origin}/auth/start?repo=owner%2Frepo`))
  const freshState = new URL(fresh.headers.get('location')).searchParams.get('state')
  const freshCookie = fresh.headers.get('set-cookie').split(';')[0]
  const callback = await handler(
    new Request(`${origin}/auth/callback?code=test&state=${freshState}`, {
      headers: { cookie: freshCookie },
    }),
  )
  assert.equal(callback.status, 302)
  assert.equal(callback.headers.get('location'), `${origin}/?repo=owner%2Frepo`)
  assert.equal(requests.length, 1)
  const exchange = JSON.parse(requests[0].options.body)
  assert.equal(exchange.client_secret, 'server-secret')
  assert.ok(exchange.code_verifier)
  assert.equal(callback.headers.getSetCookie().length, 2)
  const sessionCookie = callback.headers
    .getSetCookie()
    .find((value) => value.startsWith('atlas_session='))
    .split(';')[0]
  assert.ok(callback.headers.getSetCookie().every((value) => value.includes('HttpOnly')))
  assert.ok(!callback.headers.get('location').includes('private-token'))

  const status = await handler(
    new Request(`${origin}/auth/session`, { headers: { cookie: sessionCookie } }),
  )
  assert.deepEqual(await status.json(), { available: true, authenticated: true })
  const crossSite = await handler(
    new Request(`${origin}/api/graphql`, {
      method: 'POST',
      headers: { cookie: sessionCookie, origin: 'https://evil.example' },
      body: JSON.stringify({ query: 'query { viewer { login } }', variables: {} }),
    }),
  )
  assert.equal(crossSite.status, 403)
  const graphql = await handler(
    new Request(`${origin}/api/graphql`, {
      method: 'POST',
      headers: { cookie: sessionCookie, origin },
      body: JSON.stringify({ query: 'query { viewer { login } }', variables: {} }),
    }),
  )
  assert.equal(graphql.status, 200)
  assert.deepEqual(await graphql.json(), { data: { repository: { nameWithOwner: 'owner/repo' } } })
  assert.equal(requests[1].options.headers.Authorization, 'Bearer private-token')

  const logout = await handler(
    new Request(`${origin}/auth/logout`, {
      method: 'POST',
      headers: { cookie: sessionCookie, origin },
    }),
  )
  assert.equal(logout.status, 204)
  const afterLogout = await handler(
    new Request(`${origin}/auth/session`, { headers: { cookie: sessionCookie } }),
  )
  assert.deepEqual(await afterLogout.json(), { available: true, authenticated: false })
  assert.ok(stateCookie.startsWith('atlas_oauth_state='))
})
