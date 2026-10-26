import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { MongoClient } from 'mongodb'
import { businessCollections } from '../server/persistence/schema.ts'
import { startFakeIam, stopFakeIam } from './support/fake-iam.ts'

async function freePort() {
  const server = createNetServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test port unavailable')
  await new Promise<void>(resolve => server.close(() => resolve()))
  return address.port
}

if (!process.env.MONGODB_URI || process.env.MONGODB_DB !== 'crowfunding') throw new Error('需要本地测试 MongoDB 配置')
const prefix = `__test_procurement_freeze_${randomBytes(6).toString('hex')}_`
const names = [...businessCollections, 'agreement_versions', 'agreement_confirmations'].map(name => `${prefix}${name}`)
const client = new MongoClient(process.env.MONGODB_URI)
const fakeIam = await startFakeIam()
const order = { id: 'FREEZE-TEST', projectName: '采购差异隔离测试', sellOrder: 'FREEZE-TEST',
  totalCostPrice: 10100, totalTransactionPrice: 12000, totalSellingPrice: 12000 }
const procurement = createHttpServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ code: 0, data: { list: [order], total: 1 } }))
})
await new Promise<void>(resolve => procurement.listen(0, '127.0.0.1', resolve))
const procurementAddress = procurement.address()
if (!procurementAddress || typeof procurementAddress === 'string') throw new Error('procurement port unavailable')
let child: ReturnType<typeof spawn> | undefined
try {
  await client.connect()
  const db = client.db('crowfunding')
  const projectId = 'PRJ-FSY-OFFLINE-FREEZE-TEST'
  await db.collection(`${prefix}projects`).insertOne({ id: projectId, title: '采购差异隔离测试', source: '采购系统',
    status: '未满额', statusType: 'primary', progress: 0, remain: 100, deadline: '2099-12-31 23:59',
    total: 100, costAmount: 100, salesAmount: 120, profitAmount: 20,
    companyFixedAmount: 0, companyTakeoverAmount: 0, companyForcedTakeoverAmount: 0,
    employeeSubscribedAmount: 0, subscribed: 0, people: 0, ownerUserId: '1002', ownerDeptId: '200' })
  await db.collection(`${prefix}subscriptions`).insertOne({ id: 'SUB-FREEZE-TEST', projectId,
    project: '采购差异隔离测试', userId: '1001', amount: 100, pay: '待复核', action: '查看支付',
    createdAt: new Date().toISOString(), paymentDeadlineAt: '2099-12-31 23:59' })
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['--import', 'tsx', 'server/server.ts'], { cwd: process.cwd(),
    env: { ...process.env, API_PORT: String(port), NODE_ENV: 'test', MONGODB_COLLECTION_PREFIX: prefix,
      PROCUREMENT_API_URL: `http://127.0.0.1:${procurementAddress.port}/orders`, PROCUREMENT_TOKEN: 'test-token',
      IAM_BASE_URL: fakeIam.url, IAM_WEB_URL: fakeIam.url, IAM_CLIENT_ID: 'crowdfunding',
      IAM_CLIENT_SECRET: 'smoke-only-client-secret', IAM_REDIRECT_URI: 'http://127.0.0.1:5174/oauth/callback',
      APP_ALLOWED_ORIGIN: 'http://127.0.0.1:5174' }, stdio: 'ignore' })
  let ready = false
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) break
    try { ready = (await fetch(`${base}/api/health`)).ok; if (ready) break } catch { /* starting */ }
    await delay(100)
  }
  assert.ok(ready, '隔离 API 已启动')
  const post = async (path: string, token: string, body: Record<string, unknown> = {}) => {
    const response = await fetch(`${base}${path}`, { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  const sync = () => post('/api/mcp/sync', 'smoke-admin-full-token')
  assert.equal((await sync()).status, 200)
  let stored = await db.collection(`${prefix}projects`).findOne({ id: projectId })
  assert.equal(stored?.status, '已冻结')
  assert.equal(stored?.frozenFromStatus, '未满额')
  assert.deepEqual(stored?.procurementDifference?.fields, ['采购金额'])
  assert.equal((await post('/api/subscriptions/SUB-FREEZE-TEST/review', 'smoke-second-finance-token',
    { result: 'reject', rejectReason: '测试冻结' })).body.error, 'PROJECT_FROZEN')
  const denied = await post(`/api/projects/${projectId}/procurement-difference/resolve`,
    'smoke-admin-full-token', { action: 'continue', differenceDetails: '采购成本增加一元', reason: '继续按原发布金额执行' })
  assert.equal(denied.status, 403, JSON.stringify(denied.body))
  const resolve = await post(`/api/projects/${projectId}/procurement-difference/resolve`,
    'smoke-super-admin-token', { action: 'continue', differenceDetails: '采购成本增加一元', reason: '继续按原发布金额执行' })
  assert.equal(resolve.status, 200, JSON.stringify(resolve.body))
  stored = await db.collection(`${prefix}projects`).findOne({ id: projectId })
  assert.equal(stored?.status, '未满额')
  assert.equal(stored?.costAmount, 100)
  assert.equal(stored?.procurementAcceptedFingerprint, '[10100,12000]')
  assert.equal((await sync()).status, 200)
  assert.equal((await db.collection(`${prefix}projects`).findOne({ id: projectId }))?.status, '未满额')
  order.totalCostPrice = 10200
  assert.equal((await sync()).status, 200)
  assert.equal((await db.collection(`${prefix}projects`).findOne({ id: projectId }))?.status, '已冻结')
  console.log('procurement freeze integration passed in isolated collections')
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await Promise.race([new Promise(resolve => child!.once('exit', resolve)), delay(5000)])
  }
  await new Promise<void>(resolve => procurement.close(() => resolve()))
  await stopFakeIam(fakeIam)
  if (client.topology?.isConnected()) {
    const db = client.db('crowfunding')
    for (const name of names) {
      if (await db.listCollections({ name }, { nameOnly: true }).hasNext()) await db.collection(name).drop()
    }
  }
  await client.close()
}
