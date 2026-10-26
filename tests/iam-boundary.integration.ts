import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { MongoClient } from 'mongodb'
import { businessCollections } from '../server/persistence/schema.ts'
import { startFakeIam } from './support/fake-iam.ts'

async function freePort() {
  const listener = createServer()
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('测试端口不可用')
  await new Promise<void>(resolve => listener.close(() => resolve()))
  return address.port
}

if (!process.env.MONGODB_URI || process.env.MONGODB_DB !== 'crowfunding') throw new Error('需要本地测试 MongoDB 配置')
const prefix = `__test_iam_boundary_${randomBytes(6).toString('hex')}_`
const client = new MongoClient(process.env.MONGODB_URI)
const names = [...businessCollections, 'agreement_versions', 'agreement_confirmations'].map(name => `${prefix}${name}`)
const fake = await startFakeIam()
let child: ReturnType<typeof spawn> | undefined
try {
  await client.connect()
  const db = client.db('crowfunding')
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['--import', 'tsx', 'server/server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env, API_PORT: String(port), NODE_ENV: 'test', MONGODB_COLLECTION_PREFIX: prefix,
      IAM_BASE_URL: fake.url, IAM_CLIENT_ID: 'crowdfunding', IAM_CLIENT_SECRET: 'smoke-only-client-secret',
      IAM_REDIRECT_URI: 'http://127.0.0.1:5174/oauth/callback', APP_ALLOWED_ORIGIN: 'http://127.0.0.1:5174'
    },
    stdio: 'ignore'
  })
  let ready = false
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) break
    try { ready = (await fetch(`${base}/api/health`)).ok; if (ready) break } catch { /* startup */ }
    await delay(100)
  }
  assert.ok(ready, '隔离 API 已启动')
  const request = async (path: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}${path}`, { headers })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  assert.equal((await request('/api/projects')).status, 401)
  assert.equal((await request('/api/projects', { 'X-User-Id': 'superadmin01', 'X-User-Role': 'super_admin' })).status, 401)
  const employee = { Authorization: 'Bearer smoke-employee-token' }
  assert.equal((await request('/api/projects', employee)).status, 200)
  const departmentAdmin = await request('/api/projects', { Authorization: 'Bearer smoke-admin-token' })
  assert.equal(departmentAdmin.status, 403)
  assert.equal(departmentAdmin.body.error, 'DATA_SCOPE_MIGRATION_REQUIRED')
  assert.equal((await request('/api/projects', { Authorization: 'Bearer smoke-finance-token' })).status, 200)
  assert.equal((await request('/api/state', employee)).status, 403)
  assert.equal((await request('/api/projects', { Authorization: 'Bearer smoke-no-access-token' })).status, 403)
  assert.equal((await request('/api/projects', { Authorization: 'Bearer smoke-iam-outage-token' })).status, 503)
  assert.equal((await request('/api/unregistered', employee)).status, 404)
  const me = await request('/api/auth/me', employee)
  assert.equal(me.status, 200)
  assert.equal((me.body.data as { user: { id: string } }).user.id, '1001')
  assert.ok(fake.calls.some(call => call.path.includes('check-token')))
  console.log('IAM boundary integration passed in isolated collections')
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await Promise.race([new Promise(resolve => child!.once('exit', resolve)), delay(5000)])
  }
  await new Promise<void>(resolve => fake.server.close(() => resolve()))
  if (client.topology?.isConnected()) {
    const db = client.db('crowfunding')
    for (const name of names) {
      if (await db.listCollections({ name }, { nameOnly: true }).hasNext()) await db.collection(name).drop()
    }
  }
  await client.close()
}
