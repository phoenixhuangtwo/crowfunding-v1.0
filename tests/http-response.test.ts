import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import test from 'node:test'
import { handleCorsPreflight, sendJson, sendNoContent, sendRedirect } from '../server/http-response.ts'

const allowedOrigin = 'https://crowdfunding.example.test'

async function withServer<T>(handler: (req: IncomingMessage, res: ServerResponse) => void, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createServer(handler)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try {
    return await run(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}

test('JSON and redirects emit exact credentialed CORS without wildcard and preserve Set-Cookie fields', async () => {
  await withServer((req, res) => {
    if (req.url === '/redirect') {
      return sendRedirect(req, res, allowedOrigin, 'https://iam.example.test/oauth/login', [
        'first=one; Path=/; HttpOnly',
        'second=two; Path=/; HttpOnly'
      ])
    }
    sendJson(req, res, allowedOrigin, 200, { ok: true })
  }, async baseUrl => {
    const exact = await fetch(baseUrl, { headers: { origin: allowedOrigin } })
    assert.equal(exact.headers.get('access-control-allow-origin'), allowedOrigin)
    assert.equal(exact.headers.get('access-control-allow-credentials'), 'true')
    assert.equal(exact.headers.get('vary'), 'Origin')
    assert.equal(exact.headers.get('content-type'), 'application/json; charset=utf-8')
    assert.equal((await exact.json()).ok, true)

    for (const origin of ['https://evil.example.test', '']) {
      const response = await fetch(baseUrl, { headers: origin ? { origin } : {} })
      assert.equal(response.headers.get('access-control-allow-origin'), null)
      assert.notEqual(response.headers.get('access-control-allow-origin'), '*')
    }

    const redirect = await fetch(`${baseUrl}/redirect`, { headers: { origin: allowedOrigin }, redirect: 'manual' })
    assert.equal(redirect.status, 302)
    assert.equal(redirect.headers.get('location'), 'https://iam.example.test/oauth/login')
    assert.equal(redirect.headers.getSetCookie().length, 2)
  })
})

test('preflight permits only exact unique Origin, current methods, and approved headers', async () => {
  await withServer((req, res) => {
    if (!handleCorsPreflight(req, res, allowedOrigin)) sendJson(req, res, allowedOrigin, 404, { error: 'NOT_FOUND' })
  }, async baseUrl => {
    const ok = await fetch(baseUrl, {
      method: 'OPTIONS',
      headers: {
        origin: allowedOrigin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'Authorization, Content-Type'
      }
    })
    assert.equal(ok.status, 204)
    assert.equal(await ok.text(), '')
    assert.equal(ok.headers.get('access-control-allow-origin'), allowedOrigin)
    assert.equal(ok.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS')
    assert.equal(ok.headers.get('access-control-allow-headers'), 'Content-Type, Authorization')
    assert.equal(ok.headers.get('access-control-allow-credentials'), 'true')
    assert.equal(ok.headers.get('vary'), 'Origin')

    for (const headers of [
      {},
      { origin: 'https://evil.example.test', 'access-control-request-method': 'POST' },
      { origin: allowedOrigin, 'access-control-request-method': 'DELETE' },
      { origin: allowedOrigin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'X-User-Id' }
    ] as Array<Record<string, string>>) {
      const denied = await fetch(baseUrl, { method: 'OPTIONS', headers })
      assert.equal(denied.status, 403)
      assert.equal(denied.headers.get('access-control-allow-origin'), null)
    }
  })
})

test('duplicate Origin is denied and no-content responses have no JSON body', async () => {
  const fakeRequest = {
    method: 'OPTIONS',
    rawHeaders: ['Origin', allowedOrigin, 'Origin', allowedOrigin, 'Access-Control-Request-Method', 'POST'],
    headers: {}
  } as IncomingMessage
  let duplicateStatus = 0
  const fakeResponse = {
    writeHead(status: number) { duplicateStatus = status; return this },
    end() { return this }
  } as unknown as ServerResponse
  assert.equal(handleCorsPreflight(fakeRequest, fakeResponse, allowedOrigin), true)
  assert.equal(duplicateStatus, 403)

  await withServer((req, res) => {
    if (req.method === 'OPTIONS') return void handleCorsPreflight(req, res, allowedOrigin)
    sendNoContent(req, res, allowedOrigin, 204, ['gone=; Max-Age=0; Path=/'])
  }, async baseUrl => {
    const response = await fetch(baseUrl, { headers: { origin: allowedOrigin } })
    assert.equal(response.status, 204)
    assert.equal(await response.text(), '')
    assert.equal(response.headers.get('content-type'), null)
    assert.equal(response.headers.getSetCookie().length, 1)
  })
})
