import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { clearAccessToken, saveAccessToken } from '../src/auth/session.ts'
import { useAuthSession } from '../src/auth/use-auth-session.ts'

function installStorage() {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key), clear: () => values.clear(), key: (index: number) => [...values.keys()][index] ?? null, get length() { return values.size } }
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage })
}

function installWindow(pathname = '/projects', search = '') {
  const historyCalls: string[] = []
  const location = { pathname, search, href: `http://local.test${pathname}${search}`, assign(value: string) { this.href = value } }
  const history = { replaceState(_state: unknown, _title: string, url?: string | URL | null) { historyCalls.push(String(url ?? '')) } }
  Object.defineProperty(globalThis, 'location', { configurable: true, value: location })
  Object.defineProperty(globalThis, 'history', { configurable: true, value: history })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location, history } })
  return { location, historyCalls }
}

function response(status: number, body: unknown = {}) { return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) }

test('startup validates an existing access token and exposes authenticated IAM profile', async () => {
  installStorage(); saveAccessToken('access-token'); installWindow()
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async (_input: RequestInfo | URL) => response(200, { data: { user: { id: '101', username: 'alice', nickname: 'Alice' }, roles: ['employee'], dataScope: { all: false, self: true, deptIds: [] } } }) })
  const session = useAuthSession()
  await session.ready
  assert.equal(session.status.value, 'authenticated')
  assert.equal(session.permissionInfo.value?.user.username, 'alice')
})

test('OAuth callback exchanges code and state, cleans history, then loads me', async () => {
  installStorage(); clearAccessToken(); const browser = installWindow('/oauth/callback', '?code=one-time&state=state-1')
  const calls: Array<{ path: string; body?: string }> = []
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), 'http://local.test').pathname
    calls.push({ path, body: typeof init?.body === 'string' ? init.body : undefined })
    return path === '/api/auth/callback'
      ? response(200, { accessToken: 'callback-token', tokenType: 'Bearer', expiresIn: 300, returnTo: '/projects' })
      : response(200, { data: { user: { id: '101', username: 'alice', nickname: 'Alice' }, roles: [], dataScope: { all: true, self: false, deptIds: [] } } })
  } })
  const session = useAuthSession()
  await session.ready
  assert.equal(session.status.value, 'authenticated')
  assert.deepEqual(calls.map(call => call.path), ['/api/auth/callback', '/api/auth/me'])
  assert.deepEqual(JSON.parse(calls[0]?.body ?? '{}'), { code: 'one-time', state: 'state-1' })
  assert.deepEqual(browser.historyCalls, ['/projects'])
})

test('callback validation failure enters callback-error without sending secrets', async () => {
  installStorage(); const browser = installWindow('/oauth/callback', '?code=&state=')
  let calls = 0
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async () => { calls += 1; return response(400, { error: 'AUTH_REQUEST_INVALID' }) } })
  const session = useAuthSession()
  await session.ready
  assert.equal(session.status.value, 'callback-error')
  assert.equal(calls, 0)
  assert.deepEqual(browser.historyCalls, ['/'])
})

test('startup without token uses refresh once and preserves explicit no-access state', async () => {
  installStorage(); clearAccessToken(); installWindow()
  const calls: string[] = []
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://local.test').pathname
    calls.push(path)
    if (path === '/api/auth/refresh') return response(200, { accessToken: 'refreshed-token', tokenType: 'Bearer', expiresIn: 300 })
    return response(403, { error: 'PERMISSION_DENIED' })
  } })
  const session = useAuthSession()
  await session.ready
  assert.equal(session.status.value, 'no-access')
  assert.deepEqual(calls, ['/api/auth/refresh', '/api/auth/me'])
})

test('auth state view has explicit non-business states and App gates business shell', async () => {
  const view = await readFile(new URL('../src/components/AuthStateView.vue', import.meta.url), 'utf8')
  for (const label of ['正在验证登录状态', '正在完成统一登录', '暂无众筹系统访问权限', '统一身份服务暂不可用', '授权回调校验失败']) {
    assert.equal(view.includes(label), true, `missing state ${label}`)
  }
  assert.equal(view.includes("defineProps<"), true)
  const app = await readFile(new URL('../src/App.vue', import.meta.url), 'utf8')
  assert.match(app, /<AuthStateView[\s\S]*v-if="authSession\.status\.value !== 'authenticated'"/)
  assert.match(app, /<div v-else class="app-shell">/)
})

test('startup refresh unauthorized clears token and redirects to the auth login route', async () => {
  installStorage(); clearAccessToken(); const browser = installWindow()
  Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async () => response(401, { error: 'REFRESH_TOKEN_INVALID' }) })
  const session = useAuthSession()
  await session.ready
  assert.equal(session.status.value, 'callback-error')
  assert.equal(browser.location.href, '/api/auth/login')
})
