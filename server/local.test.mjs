import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ISSUE_DETAILS_QUERY, REPOSITORY_PAGE_QUERY } from '../src/github/queries.mjs'
import { createLocalHandler } from './local.mjs'

const origin = 'http://127.0.0.1:8769'
const graphqlRequest = (operation, variables, requestOrigin = origin) =>
  new Request(`${origin}/api/graphql`, {
    method: 'POST',
    headers: { origin: requestOrigin },
    body: JSON.stringify({ operation, variables }),
  })

test('uses the local gh login and only predefined read queries', async () => {
  const calls = []
  const handler = createLocalHandler({
    origin,
    distDir: '.',
    ghRunner: async (args, input) => {
      calls.push({ args, input })
      if (args[0] === 'auth') return ''
      return JSON.stringify({ data: { repository: { nameWithOwner: 'owner/repo' } } })
    },
  })

  const status = await handler(new Request(`${origin}/auth/session`))
  assert.deepEqual(await status.json(), { available: true, authenticated: true })
  assert.deepEqual(calls[0].args, ['auth', 'status', '--hostname', 'github.com'])

  const denied = await handler(
    graphqlRequest(
      'repository',
      {
        owner: 'owner',
        name: 'repo',
        cursor: null,
      },
      'https://evil.example',
    ),
  )
  assert.equal(denied.status, 403)
  assert.equal(calls.length, 1)

  const invalid = await handler(graphqlRequest('mutation', { owner: 'owner', name: 'repo' }))
  assert.equal(invalid.status, 400)
  assert.equal(calls.length, 1)

  const repo = await handler(
    graphqlRequest('repository', {
      owner: 'owner',
      name: 'repo',
      cursor: null,
    }),
  )
  assert.equal(repo.status, 200)
  assert.deepEqual(await repo.json(), { data: { repository: { nameWithOwner: 'owner/repo' } } })
  assert.deepEqual(calls[1].args, ['api', 'graphql', '--input', '-'])
  assert.deepEqual(JSON.parse(calls[1].input), {
    query: REPOSITORY_PAGE_QUERY,
    variables: { owner: 'owner', name: 'repo', cursor: null },
  })

  const issue = await handler(graphqlRequest('issue', { owner: 'owner', name: 'repo', number: 4 }))
  assert.equal(issue.status, 200)
  assert.equal(JSON.parse(calls[2].input).query, ISSUE_DETAILS_QUERY)
})

test('reports missing gh login without exposing command output', async () => {
  const handler = createLocalHandler({
    origin,
    distDir: '.',
    ghRunner: async () => {
      throw new Error('sensitive gh stderr')
    },
  })
  const status = await handler(new Request(`${origin}/auth/session`))
  assert.deepEqual(await status.json(), { available: true, authenticated: false })
  const response = await handler(
    graphqlRequest('repository', {
      owner: 'owner',
      name: 'repo',
      cursor: null,
    }),
  )
  assert.equal(response.status, 502)
  assert.ok(!JSON.stringify(await response.json()).includes('sensitive gh stderr'))
})
