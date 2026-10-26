import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import test from 'node:test'
import type { IamConfig } from '../server/iam/config.ts'
import { IamClient } from '../server/iam/client.ts'
import { IamProtocolError, IamUnauthorizedError, IamUnavailableError } from '../server/iam/errors.ts'
import { beginOAuth, completeOAuth, type OAuthDependencies } from '../server/iam/oauth.ts'
import { handleAuthRoute, type AuthRouteDependencies } from '../server/auth/routes.ts'

const config: IamConfig = {
  baseUrl: new URL('https://iam.example.test/'),
  clientId: 'crowdfunding',
  clientSecret: 'client-secret-never-expose',
  redirectUri: new URL('https://crowdfunding.example.test/oauth/callback'),
  scopes: ['openid', 'profile'],
  connectTimeoutMs: 2000,
  readTimeoutMs: 5000,
  refreshCookieSecure: true,
  allowedOrigin: 'https://crowdfunding.example.test',
  multiTenantEnabled: false,
  defaultTenantId: '0'
}

const fixedNow = 1_800_000_000_000
const deterministic: OAuthDependencies = {
  now: () => fixedNow,
  randomBytes: size => Buffer.alloc(size, 7)
}

function cookieHeader(setCookies: readonly string[]): string {
  return setCookies.map(cookie => cookie.split(';', 1)[0]).join('; ')
}

function tokenPair(overrides: Partial<{ accessToken: string; refreshToken: string; expiresIn: number }> = {}) {
  return {
    accessToken: overrides.accessToken ?? 'access-new',
    refreshToken: overrides.refreshToken ?? 'refresh-new',
    tokenType: 'Bearer' as const,
    expiresIn: overrides.expiresIn ?? 3600,
    clientId: 'crowdfunding' as const,
    scopes: ['openid', 'profile'],
    tenantId: '0'
  }
}

test('login builds exact S256 authorization request and hardened one-time cookies', async () => {
  const result = await beginOAuth(config, '/?page=mine', deterministic)
  const location = new URL(result.location)
  const verifier = Buffer.alloc(32, 7).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')

  assert.equal(location.origin, 'https://iam.example.test')
  assert.equal(location.pathname, '/oauth/login')
  assert.deepEqual(Object.fromEntries(location.searchParams), {
    client_id: 'crowdfunding',
    redirect_uri: 'https://crowdfunding.example.test/oauth/callback',
    response_type: 'code',
    scope: 'openid profile',
    state: location.searchParams.get('state'),
    code_challenge: challenge,
    code_challenge_method: 'S256'
  })
  assert.match(location.searchParams.get('state') ?? '', /^[A-Za-z0-9_-]{50,}$/)
  assert.equal(location.search.includes(config.clientSecret), false)
  assert.equal(location.search.includes(verifier), false)
  assert.equal(result.cookies.length, 3)
  for (const cookie of result.cookies) {
    assert.match(cookie, /Max-Age=300/)
    assert.match(cookie, /HttpOnly/)
    assert.match(cookie, /SameSite=Lax/)
    assert.match(cookie, /Path=\/api\/auth/)
    assert.match(cookie, /Secure/)
    assert.doesNotMatch(cookie, /Domain=/)
  }
})

test('login omits Secure only when configured and normalizes unsafe return paths', async () => {
  const insecure = { ...config, refreshCookieSecure: false }
  const unsafe = [
    '//evil.example/x',
    'https://evil.example/x',
    '/safe\\evil',
    '/safe%5cevil',
    '/safe\u0000evil',
    '/safe#//evil.example',
    '/%E0%A4%A'
  ]
  for (const returnTo of unsafe) {
    const result = await beginOAuth(insecure, returnTo, deterministic)
    assert.equal(result.cookies.some(cookie => cookie.includes('Secure')), false)
    const returnCookie = result.cookies.find(cookie => cookie.startsWith('crowdfunding_oauth_return='))
    assert.equal(returnCookie?.split(';', 1)[0], 'crowdfunding_oauth_return=%2F')
  }
})

test('callback validates state and expiry before exchanging and exposes no refresh token', async () => {
  const login = await beginOAuth(config, '/projects?mine=1', deterministic)
  const state = new URL(login.location).searchParams.get('state')!
  const calls: Array<{ code: string; state: string; verifier: string }> = []
  const iam = {
    config,
    async exchangeCode(input: { code: string; state: string; verifier: string }) {
      calls.push(input)
      return tokenPair()
    }
  }
  const result = await completeOAuth(
    { headers: { cookie: cookieHeader(login.cookies) }, rawHeaders: [] },
    { code: 'one-time-code', state },
    iam,
    deterministic
  )
  assert.deepEqual({ ...result, cookies: undefined }, {
    accessToken: 'access-new', tokenType: 'Bearer', expiresIn: 3600, returnTo: '/projects?mine=1', cookies: undefined
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.code, 'one-time-code')
  assert.equal(calls[0]?.state, state)
  assert.equal(calls[0]?.verifier, Buffer.alloc(32, 7).toString('base64url'))
  assert.equal(result.cookies.filter(cookie => /Max-Age=0/.test(cookie)).length, 3)
  const refresh = result.cookies.find(cookie => cookie.startsWith('crowdfunding_refresh='))!
  assert.match(refresh, /HttpOnly/)
  assert.match(refresh, /SameSite=Strict/)
  assert.match(refresh, /Path=\/api\/auth/)
  assert.match(refresh, /Max-Age=2592000/)
  assert.match(refresh, /Secure/)

  for (const body of [
    { code: '', state },
    { code: ['a', 'b'], state },
    { code: 'x'.repeat(4097), state },
    { code: 'code', state: '' },
    { code: 'code', state: ['a', 'b'] },
    { code: 'code', state: `${state.slice(0, -1)}A` }
  ]) {
    await assert.rejects(() => completeOAuth(
      { headers: { cookie: cookieHeader(login.cookies) }, rawHeaders: [] }, body, iam, deterministic
    ), /OAuth 回调校验失败/)
  }
  assert.equal(calls.length, 1)

  await assert.rejects(() => completeOAuth(
    { headers: { cookie: cookieHeader(login.cookies) }, rawHeaders: [] },
    { code: 'code', state }, iam, { ...deterministic, now: () => fixedNow + 300_001 }
  ), /OAuth 回调校验失败/)
  assert.equal(calls.length, 1)
})

test('callback rejects missing, malformed, and duplicate OAuth cookies before exchange', async () => {
  const login = await beginOAuth(config, '/', deterministic)
  const state = new URL(login.location).searchParams.get('state')!
  let exchanges = 0
  const iam = { config, exchangeCode: async () => { exchanges += 1; return tokenPair() } }
  const valid = cookieHeader(login.cookies)
  for (const cookie of [
    '',
    valid.replace(/crowdfunding_oauth_verifier=[^;]+;? ?/, ''),
    `${valid}; crowdfunding_oauth_state=duplicate`,
    valid.replace(/crowdfunding_oauth_return=[^;]+/, 'crowdfunding_oauth_return=%E0%A4%A')
  ]) {
    await assert.rejects(() => completeOAuth(
      { headers: { cookie }, rawHeaders: [] }, { code: 'code', state }, iam, deterministic
    ), /OAuth 回调校验失败/)
  }
  assert.equal(exchanges, 0)
})

type RouteIam = AuthRouteDependencies['iam'] & {
  exchangeCalls: number
  refreshCalls: string[]
  revokeCalls: string[]
}

function routeIam(): RouteIam {
  return {
    config,
    exchangeCalls: 0,
    refreshCalls: [],
    revokeCalls: [],
    async exchangeCode() { this.exchangeCalls += 1; return tokenPair() },
    async refresh(value) { this.refreshCalls.push(value); return tokenPair({ accessToken: 'access-rotated', refreshToken: 'refresh-rotated' }) },
    async revoke(value) { this.revokeCalls.push(value); return true }
  }
}

async function withAuthServer<T>(dependencies: AuthRouteDependencies, run: (baseUrl: string) => Promise<T>): Promise<T> {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (!await handleAuthRoute(req, res, url, dependencies)) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":"NOT_FOUND"}')
    }
  })
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

test('callback route deletes one-time cookies on success and every failure without leaking secrets', async () => {
  const iam = routeIam()
  await withAuthServer({ config, iam, oauth: deterministic }, async baseUrl => {
    const loginResponse = await fetch(`${baseUrl}/api/auth/login?returnTo=%2Fmine`, { redirect: 'manual' })
    const location = loginResponse.headers.get('location')!
    const state = new URL(location).searchParams.get('state')!
    const cookies = loginResponse.headers.getSetCookie()
    const validCookie = cookieHeader(cookies)

    const success = await fetch(`${baseUrl}/api/auth/callback`, {
      method: 'POST', headers: { cookie: validCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'one-time-code', state })
    })
    assert.equal(success.status, 200)
    const successBody = await success.json()
    assert.deepEqual(Object.keys(successBody).sort(), ['accessToken', 'expiresIn', 'returnTo', 'tokenType'])
    assert.equal(JSON.stringify(successBody).includes('refresh-new'), false)
    assert.equal(success.headers.getSetCookie().filter(cookie => /Max-Age=0/.test(cookie)).length, 3)

    for (const request of [
      { body: '{', cookie: validCookie },
      { body: `{"code":"a","code":"b","state":"${state}"}`, cookie: validCookie },
      { body: JSON.stringify({ code: 'x', state: 'wrong' }), cookie: validCookie },
      { body: JSON.stringify({ code: 'x', state }), cookie: '' }
    ]) {
      const response = await fetch(`${baseUrl}/api/auth/callback`, {
        method: 'POST', headers: { cookie: request.cookie, 'content-type': 'application/json' }, body: request.body
      })
      assert.equal(response.status, 400)
      assert.equal(response.headers.getSetCookie().filter(cookie => /Max-Age=0/.test(cookie)).length, 3)
      const text = await response.text()
      assert.equal(text.includes(state), false)
      assert.equal(text.includes(config.clientSecret), false)
    }
  })
})

test('refresh rotates only the cookie token, rejects stale cookies, and maps IAM failures safely', async () => {
  const iam = routeIam()
  await withAuthServer({ config, iam, oauth: deterministic }, async baseUrl => {
    const response = await fetch(`${baseUrl}/api/auth/refresh?refresh_token=query-is-ignored`, {
      method: 'POST', headers: { cookie: 'crowdfunding_refresh=refresh-old', 'content-type': 'application/json' }, body: '{}'
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { accessToken: 'access-rotated', tokenType: 'Bearer', expiresIn: 3600 })
    assert.deepEqual(iam.refreshCalls, ['refresh-old'])
    assert.equal(response.headers.getSetCookie().length, 1)
    assert.equal(response.headers.getSetCookie()[0]?.includes('refresh-rotated'), true)

    for (const cookie of ['', 'crowdfunding_refresh=', 'crowdfunding_refresh=a; crowdfunding_refresh=b', 'crowdfunding_refresh=%E0%A4%A']) {
      const stale = await fetch(`${baseUrl}/api/auth/refresh`, { method: 'POST', headers: { cookie } })
      assert.equal(stale.status, 401)
      assert.match(stale.headers.getSetCookie()[0] ?? '', /Max-Age=0/)
    }
  })

  for (const [error, status, clear] of [
    [new IamUnauthorizedError(), 401, true],
    [new IamUnavailableError(), 503, false],
    [new IamProtocolError(), 503, false]
  ] as const) {
    const failing = routeIam()
    failing.refresh = async () => { throw error }
    await withAuthServer({ config, iam: failing, oauth: deterministic }, async baseUrl => {
      const response = await fetch(`${baseUrl}/api/auth/refresh`, { method: 'POST', headers: { cookie: 'crowdfunding_refresh=stale-secret' } })
      assert.equal(response.status, status)
      assert.equal(response.headers.getSetCookie().some(cookie => /Max-Age=0/.test(cookie)), clear)
      const text = await response.text()
      assert.equal(text.includes('stale-secret'), false)
    })
  }
})

test('real IAM client classifies token-grant 4xx for callback and refresh without confusing dependency failures', async () => {
  const login = await beginOAuth(config, '/mine', deterministic)
  const state = new URL(login.location).searchParams.get('state')!
  const callbackCookie = cookieHeader(login.cookies)

  for (const status of [400, 401, 403]) {
    const responseBody = JSON.stringify({ code: status, message: `rejected client-secret-never-expose code-${status}` })
    const callbackIam = new IamClient(config, {
      fetch: async () => new Response(responseBody, { status })
    })
    await withAuthServer({ config, iam: callbackIam, oauth: deterministic }, async baseUrl => {
      const response = await fetch(`${baseUrl}/api/auth/callback`, {
        method: 'POST',
        headers: { cookie: callbackCookie, 'content-type': 'application/json' },
        body: JSON.stringify({ code: `rejected-code-${status}`, state })
      })
      assert.equal(response.status, 400)
      assert.equal(response.headers.getSetCookie().filter(cookie => /Max-Age=0/.test(cookie)).length, 3)
      assert.equal(response.headers.getSetCookie().some(cookie => cookie.startsWith('crowdfunding_refresh=')), false)
      const text = await response.text()
      assert.match(text, /OAUTH_CALLBACK_INVALID/)
      assert.equal(text.includes('client-secret-never-expose'), false)
      assert.equal(text.includes(`rejected-code-${status}`), false)
      assert.equal(text.includes(state), false)
    })

    const refreshIam = new IamClient(config, {
      fetch: async () => new Response(responseBody, { status })
    })
    await withAuthServer({ config, iam: refreshIam, oauth: deterministic }, async baseUrl => {
      const response = await fetch(`${baseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { cookie: `crowdfunding_refresh=stale-refresh-${status}` }
      })
      assert.equal(response.status, 401)
      assert.equal(response.headers.getSetCookie().length, 1)
      assert.match(response.headers.getSetCookie()[0] ?? '', /^crowdfunding_refresh=; Max-Age=0/)
      const text = await response.text()
      assert.equal(text.includes('client-secret-never-expose'), false)
      assert.equal(text.includes(`stale-refresh-${status}`), false)
    })
  }

  for (const iamResponse of [
    () => new Response('{"code":503}', { status: 503 }),
    () => new Response('{"code":', { status: 200 }),
    () => new Response('{"code":9,"data":{}}', { status: 200 })
  ]) {
    const iam = new IamClient(config, { fetch: async () => iamResponse() })
    await withAuthServer({ config, iam, oauth: deterministic }, async baseUrl => {
      const response = await fetch(`${baseUrl}/api/auth/refresh`, {
        method: 'POST', headers: { cookie: 'crowdfunding_refresh=possibly-valid-refresh' }
      })
      assert.equal(response.status, 503)
      assert.equal(response.headers.getSetCookie().length, 0)
      assert.match(await response.text(), /IAM_UNAVAILABLE/)
    })
  }
})

test('same refresh token is single-flight guarded by digest and guard releases after success or failure', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const iam = routeIam()
  iam.refresh = async value => {
    iam.refreshCalls.push(value)
    await gate
    return tokenPair()
  }
  await withAuthServer({ config, iam, oauth: deterministic }, async baseUrl => {
    const first = fetch(`${baseUrl}/api/auth/refresh`, { method: 'POST', headers: { cookie: 'crowdfunding_refresh=same-token' } })
    while (iam.refreshCalls.length === 0) await new Promise(resolve => setTimeout(resolve, 1))
    const duplicate = await fetch(`${baseUrl}/api/auth/refresh`, { method: 'POST', headers: { cookie: 'crowdfunding_refresh=same-token' } })
    assert.equal(duplicate.status, 409)
    release()
    assert.equal((await first).status, 200)
    assert.equal((await fetch(`${baseUrl}/api/auth/refresh`, { method: 'POST', headers: { cookie: 'crowdfunding_refresh=same-token' } })).status, 200)
  })

  const failing = routeIam()
  failing.refresh = async () => { throw new IamUnavailableError() }
  await withAuthServer({ config, iam: failing, oauth: deterministic }, async baseUrl => {
    assert.equal((await fetch(`${baseUrl}/api/auth/refresh`, { method: 'POST', headers: { cookie: 'crowdfunding_refresh=retry-token' } })).status, 503)
    assert.equal((await fetch(`${baseUrl}/api/auth/refresh`, { method: 'POST', headers: { cookie: 'crowdfunding_refresh=retry-token' } })).status, 503)
  })
})

test('logout revokes only one Bearer token, clears all auth cookies, and known route methods are strict', async () => {
  const iam = routeIam()
  await withAuthServer({ config, iam, oauth: deterministic }, async baseUrl => {
    const logout = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST', headers: { authorization: 'Bearer access-only' } })
    assert.equal(logout.status, 204)
    assert.equal(await logout.text(), '')
    assert.deepEqual(iam.revokeCalls, ['access-only'])
    assert.equal(logout.headers.getSetCookie().length, 4)
    assert.equal(logout.headers.getSetCookie().every(cookie => /Max-Age=0/.test(cookie)), true)

    assert.equal((await fetch(`${baseUrl}/api/auth/logout?token=query-token`, { method: 'POST', headers: { authorization: 'Bearer access' } })).status, 400)
    const bodyToken = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { authorization: 'Bearer access', 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'body-token' })
    })
    assert.equal(bodyToken.status, 400)
    assert.deepEqual(iam.revokeCalls, ['access-only'])
    assert.equal((await fetch(`${baseUrl}/api/auth/login`, { method: 'POST' })).status, 405)
    assert.equal((await fetch(`${baseUrl}/api/auth/callback`)).status, 405)
    assert.equal((await fetch(`${baseUrl}/api/auth/unknown`)).status, 404)
  })
})
