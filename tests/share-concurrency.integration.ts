import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { MongoClient } from 'mongodb'
import { businessCollections } from '../server/persistence/schema.ts'
import { startFakeIam, stopFakeIam } from './support/fake-iam.ts'

async function freePort() {
  const listener = createServer()
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('测试端口不可用')
  await new Promise<void>(resolve => listener.close(() => resolve()))
  return address.port
}

if (!process.env.MONGODB_URI || process.env.MONGODB_DB !== 'crowfunding') throw new Error('需要本地测试 MongoDB 配置')
const prefix = `__test_share_race_${randomBytes(6).toString('hex')}_`
const names = [...businessCollections, 'agreement_versions', 'agreement_confirmations'].map(name => `${prefix}${name}`)
const client = new MongoClient(process.env.MONGODB_URI)
const fakeIam = await startFakeIam()
let child: ReturnType<typeof spawn> | undefined
try {
  await client.connect()
  const db = client.db('crowfunding')
  await db.collection(`${prefix}agreement_versions`).insertOne({
    id: 'AGREEMENT-SHARE-RACE', version: 1, title: '并发认购隔离协议',
    body: '测试协议', effectiveAt: new Date().toISOString(), createdBy: 'integration-test'
  })
  await db.collection(`${prefix}projects`).insertOne({
    id: 'PRJ-SHARE-RACE', title: '最后一份并发认购', source: 'integration-test',
    status: '未满额', statusType: 'primary', progress: 0, remain: 100, deadline: '2099-12-31 23:59',
    total: 100, costAmount: 100, salesAmount: 120, profitAmount: 20,
    companyFixedAmount: 0, companyTakeoverAmount: 0, companyForcedTakeoverAmount: 0,
    employeeSubscribedAmount: 0, subscribed: 0, people: 0, ruleId: 'RULE-SHARE-RACE'
  })
  await db.collection(`${prefix}subscription_rules`).insertOne({
    id: 'RULE-SHARE-RACE', projectId: 'PRJ-SHARE-RACE', projectName: '最后一份并发认购',
    ruleName: '按份并发规则', totalAmount: 100, companyFixedAmount: 0, sharePrice: 100,
    totalShares: 1, companyFrontShares: 0, maxSharesPerEmployee: 1,
    minAmount: 100, minParticipants: 1, allowMultiple: true, companyTakeover: false,
    status: '已启用', startAt: '', endAt: '2099-12-31 23:59',
    paymentCutoffAt: '2100-01-01 12:00', plannedPaymentDate: '2100-01-02', updatedAt: new Date().toISOString()
  })
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['--import', 'tsx', 'server/server.ts'], { cwd: process.cwd(),
    env: { ...process.env, API_PORT: String(port), NODE_ENV: 'test', MONGODB_COLLECTION_PREFIX: prefix,
      IAM_BASE_URL: fakeIam.url, IAM_WEB_URL: fakeIam.url, IAM_CLIENT_ID: 'crowdfunding',
      IAM_CLIENT_SECRET: 'smoke-only-client-secret', IAM_REDIRECT_URI: 'http://127.0.0.1:5174/oauth/callback',
      APP_ALLOWED_ORIGIN: 'http://127.0.0.1:5174' }, stdio: 'ignore' })
  let ready = false
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) break
    try { ready = (await fetch(`${base}/api/health`)).ok; if (ready) break } catch { /* startup */ }
    await delay(100)
  }
  assert.ok(ready, '隔离 API 已启动')
  const attempts = await Promise.all(Array.from({ length: 20 }, async (_, index) => {
    const response = await fetch(`${base}/api/subscriptions`, { method: 'POST',
      headers: { Authorization: `Bearer ${index % 2 === 0 ? 'smoke-employee-token' : 'smoke-second-employee-token'}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'PRJ-SHARE-RACE', shares: 1,
        idempotencyKey: `last-share-${index}`, agreementsConfirmed: true, agreementVersion: 1 }) })
    return { status: response.status, body: await response.json() as { error?: string } }
  }))
  assert.equal(attempts.filter(item => item.status === 201).length, 1, JSON.stringify(attempts))
  assert.ok(attempts.every(item => [201, 400, 409].includes(item.status)), JSON.stringify(attempts))
  assert.equal(await db.collection(`${prefix}subscriptions`).countDocuments({ projectId: 'PRJ-SHARE-RACE' }), 1)
  assert.equal(await db.collection(`${prefix}agreement_confirmations`).countDocuments({ node: '提交认购' }), 1)
  const project = await db.collection(`${prefix}projects`).findOne({ id: 'PRJ-SHARE-RACE' })
  assert.equal(project?.employeeSubscribedAmount, 100)
  assert.equal(project?.subscribed, 100)
  assert.equal(project?.remain, 0)
  assert.equal(project?.people, 1)
  assert.equal(project?.status, '已满额')
  process.stdout.write('最后一份并发认购隔离测试通过\n')
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await Promise.race([new Promise(resolve => child!.once('exit', resolve)), delay(5000)])
  }
  if (client.topology?.isConnected()) {
    const db = client.db('crowfunding')
    for (const name of names) {
      if (await db.listCollections({ name }, { nameOnly: true }).hasNext()) await db.collection(name).drop()
    }
  }
  await client.close()
  await stopFakeIam(fakeIam)
}
