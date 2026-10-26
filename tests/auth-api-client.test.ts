import assert from 'node:assert/strict'
import test from 'node:test'

import { apiRequest, ApiError, __resetApiClientForTests } from '../src/auth/api-client.ts'
import { clearAccessToken, readAccessToken, saveAccessToken } from '../src/auth/session.ts'

function installStorage() {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)) },
    removeItem: (key: string) => { values.delete(key) },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size }
  }
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { length: 0 } })
  return storage
}

function response(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

test('access token is stored only in sessionStorage', () => {
  const storage = installStorage()
  clearAccessToken()
  saveAccessToken('opaque-token')
  assert.equal(readAccessToken(), 'opaque-token')
  assert.equal(storage.getItem('crowdfunding.access_token'), 'opaque-token')
  assert.equal(storage.length, 1)
  assert.equal((globalThis as any).localStorage.length, 0)
  clearAccessToken()
  assert.equal(readAccessToken(), null)
})

test('parallel 401 responses share one refresh and retry once', async () => {
  installStorage()
  saveAccessToken('old-token')
  __resetApiClientForTests()
  const calls: Array<{ path: string; authorization: string | null }> = []
  let refreshResolve: ((value: Response) => void) | undefined
  let initial401 = 0
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://local.test').pathname
    calls.push({ path, authorization: new Headers(init?.headers).get('Authorization') })
    if (path === '/api/auth/refresh') return await new Promise<Response>(resolve => { refreshResolve = resolve })
    if (initial401++ < 2) return response(401, { error: 'AUTH_REQUIRED' })
    return response(200, { ok: true })
  } })
  const first = apiRequest<{ ok: boolean }>('/api/projects')
  const second = apiRequest<{ ok: boolean }>('/api/subscriptions')
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(calls.filter(call => call.path === '/api/auth/refresh').length, 1)
  refreshResolve?.(response(200, { accessToken: 'new-token', tokenType: 'Bearer', expiresIn: 300 }))
  assert.deepEqual(await Promise.all([first, second]), [{ ok: true }, { ok: true }])
  assert.equal(readAccessToken(), 'new-token')
  assert.deepEqual(calls.filter(call => call.path === '/api/auth/refresh').map(call => call.authorization), [null])
  assert.equal(calls.filter(call => call.path !== '/api/auth/refresh').every(call => call.authorization === 'Bearer old-token' || call.authorization === 'Bearer new-token'), true)
})

test('business 403 does not refresh and maps to FORBIDDEN', async () => {
  installStorage(); saveAccessToken('still-valid'); __resetApiClientForTests()
  const calls: string[] = []
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async (input: RequestInfo | URL) => {
    calls.push(new URL(String(input), 'http://local.test').pathname)
    return response(403, { error: 'PERMISSION_DENIED' })
  } })
  await assert.rejects(apiRequest('/api/admin'), (error: unknown) => error instanceof ApiError && error.code === 'FORBIDDEN' && error.status === 403)
  assert.deepEqual(calls, ['/api/admin'])
  assert.equal(readAccessToken(), 'still-valid')
})

test('IAM 503 preserves access token and maps to IAM_UNAVAILABLE', async () => {
  installStorage(); saveAccessToken('outage-token'); __resetApiClientForTests()
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async () => response(503, { error: 'IAM_UNAVAILABLE' }) })
  await assert.rejects(apiRequest('/api/projects'), (error: unknown) => error instanceof ApiError && error.code === 'IAM_UNAVAILABLE' && error.status === 503)
  assert.equal(readAccessToken(), 'outage-token')
})

test('refresh 401 clears token and redirects to login', async () => {
  installStorage(); saveAccessToken('expired-token'); __resetApiClientForTests()
  const location = { pathname: '/projects', href: 'http://local.test/projects', assign(value: string) { this.href = value } }
  Object.defineProperty(globalThis, 'location', { configurable: true, value: location })
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://local.test').pathname
    return path === '/api/auth/refresh' ? response(401, { error: 'REFRESH_TOKEN_INVALID' }) : response(401, { error: 'AUTH_REQUIRED' })
  } })
  await assert.rejects(apiRequest('/api/projects'), (error: unknown) => error instanceof ApiError && error.code === 'AUTH_REQUIRED')
  assert.equal(readAccessToken(), null)
  assert.equal(location.href, '/api/auth/login')
})

test('a retried 401 is not refreshed a second time', async () => {
  installStorage(); saveAccessToken('old-token'); __resetApiClientForTests()
  const location = { href: '/projects', assign(value: string) { this.href = value } }
  Object.defineProperty(globalThis, 'location', { configurable: true, value: location })
  const calls: string[] = []
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://local.test').pathname
    calls.push(path)
    if (path === '/api/auth/refresh') return response(200, { accessToken: 'new-token', tokenType: 'Bearer', expiresIn: 300 })
    return response(401, { error: 'AUTH_REQUIRED' })
  } })
  await assert.rejects(apiRequest('/api/projects'), (error: unknown) => error instanceof ApiError && error.code === 'AUTH_REQUIRED')
  assert.deepEqual(calls, ['/api/projects', '/api/auth/refresh', '/api/projects'])
  assert.equal(readAccessToken(), null)
  assert.equal(location.href, '/api/auth/login')
})

test('FormData requests omit JSON content type while retaining same-origin credentials', async () => {
  installStorage(); saveAccessToken('upload-token'); __resetApiClientForTests()
  let seen: RequestInit | undefined
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async (_input: RequestInfo | URL, init?: RequestInit) => { seen = init; return response(200, { ok: true }) } })
  await apiRequest('/api/upload', { method: 'POST', body: new FormData() })
  assert.equal(seen?.credentials, 'same-origin')
  assert.equal(new Headers(seen?.headers).get('Authorization'), 'Bearer upload-token')
  assert.equal(new Headers(seen?.headers).has('Content-Type'), false)
})

test('requests without an access token omit Authorization entirely', async () => {
  installStorage(); clearAccessToken(); __resetApiClientForTests()
  let seen: RequestInit | undefined
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async (_input: RequestInfo | URL, init?: RequestInit) => { seen = init; return response(200, { ok: true }) } })
  await apiRequest('/api/health')
  assert.equal(new Headers(seen?.headers).has('Authorization'), false)
  assert.equal(seen?.credentials, 'same-origin')
})
