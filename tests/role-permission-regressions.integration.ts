import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { MongoClient } from 'mongodb'
import { startFakeIam, stopFakeIam } from './support/fake-iam.ts'

assert.equal(process.env.MONGODB_DB, 'crowfunding')
assert.ok(process.env.MONGODB_URI)
const prefix = `__test_role_regression_${randomBytes(6).toString('hex')}_`
const client = new MongoClient(process.env.MONGODB_URI)
const fake = await startFakeIam()
let child: ReturnType<typeof spawn> | undefined
try {
  await client.connect()
  const db = client.db('crowfunding')
  const ownership = { tenantId: '0', ownerUserId: '1002', ownerDeptId: '200' }
  const project = { title: '权限回归项目', status: '未满额', statusType: 'primary', deadline: '2099-12-31 23:59',
    costAmount: 300, salesAmount: 360, total: 300, remain: 300, subscribed: 0, progress: 0,
    employeeSubscribedAmount: 0, companyFixedAmount: 0, companyTakeoverAmount: 0, companyForcedTakeoverAmount: 0, people: 0, ...ownership }
  await db.collection(prefix + 'projects').insertMany([
    { ...project, id: 'PRJ-ROLE-OPEN' }, { ...project, id: 'PRJ-ROLE-OTHER', ownerUserId: '9999' },
    { ...project, id: 'PRJ-ROLE-DRAFT', status: '未开放' },
    { ...project, id: 'PRJ-ROLE-FROZEN', status: '已冻结' },
    { ...project, id: 'PRJ-ROLE-EXPIRED', deadline: '2020-01-01 00:00' }
  ])
  await db.collection(prefix + 'receiving_codes').insertOne({ id: 'RC-ROLE', subject: '测试', accountNote: '测试', codeName: '测试码', status: '已禁用', disabledReason: '验收测试', ...ownership })
  await db.collection(prefix + 'subscriptions').insertMany(['REJECT', 'PARTIAL', 'FROZEN', 'NO-REASON'].map(kind => ({
    id: `SUB-ROLE-${kind}`, projectId: kind === 'FROZEN' ? 'PRJ-ROLE-FROZEN' : 'PRJ-ROLE-OPEN',
    userId: '1001', amount: 100, shares: 1, pay: '待复核', createdAt: new Date().toISOString(), paymentDeadlineAt: '2099-12-31 23:59'
  })))
  const listener = createServer(); await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
  const port = (listener.address() as { port: number }).port; await new Promise<void>(resolve => listener.close(() => resolve()))
  child = spawn(process.execPath, ['--import', 'tsx', 'server/server.ts'], { cwd: process.cwd(),
    env: { ...process.env, API_PORT: String(port), NODE_ENV: 'test', MONGODB_COLLECTION_PREFIX: prefix,
      IAM_BASE_URL: fake.url, IAM_WEB_URL: fake.url, IAM_CLIENT_ID: 'crowdfunding', IAM_CLIENT_SECRET: 'smoke-only-client-secret',
      IAM_REDIRECT_URI: 'http://127.0.0.1:5174/oauth/callback', APP_ALLOWED_ORIGIN: 'http://127.0.0.1:5174' }, stdio: 'ignore' })
  const base = `http://127.0.0.1:${port}`
  let ready = false
  for (let n = 0; n < 100; n++) { try { ready = (await fetch(base + '/api/health')).ok; if (ready) break } catch {} await delay(100) }
  assert.ok(ready)
  async function request(path: string, token = 'smoke-employee-token', body?: unknown) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, body: await response.json() as any }
  }
  await test('existing project detail is queryable by the four roles', async () => {
    for (const token of ['smoke-employee-token', 'smoke-admin-full-token', 'smoke-finance-token', 'smoke-super-admin-token']) {
      const response = await request('/api/projects/PRJ-ROLE-OPEN', token)
      assert.equal(response.status, 200); assert.equal(response.body.data.id, 'PRJ-ROLE-OPEN')
    }
  })
  await test('detail preserves employee availability and administrator ownership boundaries', async () => {
    for (const id of ['PRJ-ROLE-DRAFT', 'PRJ-ROLE-EXPIRED', 'MISSING']) assert.equal((await request('/api/projects/' + id)).status, 404)
    assert.equal((await request('/api/projects/PRJ-ROLE-OTHER', 'smoke-admin-full-token')).status, 404)
    assert.equal((await request('/api/projects/PRJ-ROLE-DRAFT', 'smoke-admin-full-token')).status, 200)
  })
  await test('administrator can re-enable a receiving code idempotently with audit', async () => {
    for (let n = 0; n < 2; n++) assert.equal((await request('/api/receiving-codes/RC-ROLE/enable', 'smoke-admin-full-token', {})).status, 200)
    const record = await db.collection(prefix + 'receiving_codes').findOne({ id: 'RC-ROLE' })
    assert.equal(record?.status, '启用'); assert.equal(record?.disabledReason, undefined)
    assert.equal(await db.collection(prefix + 'audit_logs').countDocuments({ target: 'RC-ROLE', action: '启用收款码' }), 1)
  })
  await test('re-enable rejects unauthorized roles and handles missing codes', async () => {
    assert.equal((await request('/api/receiving-codes/RC-ROLE/enable', 'smoke-super-admin-token', {})).status, 403)
    assert.equal((await request('/api/receiving-codes/RC-ROLE/enable', 'smoke-employee-token', {})).status, 403)
    assert.equal((await request('/api/receiving-codes/MISSING/enable', 'smoke-admin-full-token', {})).status, 404)
  })
  for (const [action, id, status] of [['reject', 'REJECT', '复核驳回'], ['partial', 'PARTIAL', '部分缴款']]) {
    await test(`finance can ${action} a share-based contribution without recognizing funds or releasing shares`, async () => {
      const path = `/api/subscriptions/SUB-ROLE-${id}/review`
      const result = await request(path, 'smoke-second-finance-token', { result: action, rejectReason: '真实接口回归测试驳回理由' })
      assert.equal(result.status, 200)
      const record = await db.collection(prefix + 'subscriptions').findOne({ id: `SUB-ROLE-${id}` })
      assert.equal(record?.pay, status); assert.equal(record?.shares, 1)
      assert.equal(await db.collection(prefix + 'fund_ledger').countDocuments({ subscriptionId: record?.id }), 0)
      assert.equal(await db.collection(prefix + 'audit_logs').countDocuments({ target: record?.id }), 1)
      assert.equal((await request(path, 'smoke-second-finance-token', { result: action, rejectReason: '重复提交' })).status, 409)
    })
  }
  await test('share review still rejects frozen projects and missing rejection reasons', async () => {
    assert.equal((await request('/api/subscriptions/SUB-ROLE-NO-REASON/review', 'smoke-second-finance-token', { result: 'reject' })).status, 400)
    assert.equal((await request('/api/subscriptions/SUB-ROLE-FROZEN/review', 'smoke-second-finance-token', { result: 'reject', rejectReason: '冻结拦截' })).status, 409)
  })
} finally {
  child?.kill('SIGTERM'); if (child && child.exitCode === null) await new Promise(resolve => child!.once('exit', resolve))
  for (const collection of await client.db('crowfunding').listCollections().toArray()) if (collection.name.startsWith(prefix)) await client.db('crowfunding').collection(collection.name).drop()
  await client.close(); await stopFakeIam(fake)
}
