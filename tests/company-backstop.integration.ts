import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { MongoClient } from 'mongodb'
import { businessCollections } from '../server/persistence/schema.ts'

const uri = process.env.MONGODB_URI
if (!uri || process.env.MONGODB_DB !== 'crowfunding') throw new Error('需要本地测试 MongoDB 配置')
const prefix = `__test_backstop_${randomBytes(6).toString('hex')}_`
const client = new MongoClient(uri)
await client.connect()
const db = client.db('crowfunding')
const names = businessCollections.map(name => `${prefix}${name}`)
if ((await db.listCollections({ name: { $in: names } }, { nameOnly: true }).toArray()).length) throw new Error('测试前缀已存在')

async function freePort() {
  const listener = createServer()
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('测试端口不可用')
  await new Promise<void>(resolve => listener.close(() => resolve()))
  return address.port
}

let child: ReturnType<typeof spawn> | undefined
try {
  await db.collection(`${prefix}projects`).insertOne({
    id: 'PRJ-BACKSTOP-TEST', title: '自动兜底隔离测试', source: 'integration-test',
    status: '已满额', statusType: 'success', progress: 100, remain: 0, deadline: '2020-01-01 00:00',
    total: 200, costAmount: 300, salesAmount: 360, profitAmount: 60,
    companyFixedAmount: 100, companyTakeoverAmount: 0, companyForcedTakeoverAmount: 0,
    employeeSubscribedAmount: 200, subscribed: 300, people: 2, ruleId: 'RULE-BACKSTOP-TEST'
  })
  await db.collection(`${prefix}subscription_rules`).insertOne({
    id: 'RULE-BACKSTOP-TEST', projectId: 'PRJ-BACKSTOP-TEST', projectName: '自动兜底隔离测试',
    ruleName: '按份规则', totalAmount: 200, sharePrice: 100, totalShares: 3,
    companyFrontShares: 1, maxSharesPerEmployee: 1, companyFixedAmount: 100,
    minAmount: 100, minParticipants: 1, allowMultiple: false, companyTakeover: true,
    status: '已启用', startAt: '2019-12-01 00:00', endAt: '2020-01-01 00:00', updatedAt: '2019-12-01 00:00'
  })
  for (const [id, pay] of [['unpaid', '未缴款'], ['pending', '待复核']] as const) {
    await db.collection(`${prefix}subscriptions`).insertOne({
      id: `SUB-${id}`, projectId: 'PRJ-BACKSTOP-TEST', project: '自动兜底隔离测试',
      userId: `employee-${id}`, amount: 100, shares: 1, pay, profit: 60,
      action: '查看支付', idempotencyKey: `backstop-${id}`, createdAt: '2019-12-31 00:00',
      paymentDeadlineAt: '2020-01-01 12:00'
    })
  }
  const port = await freePort()
  child = spawn(process.execPath, ['--import', 'tsx', 'server/server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, API_PORT: String(port), NODE_ENV: 'test', MONGODB_COLLECTION_PREFIX: prefix },
    stdio: 'ignore'
  })
  let settled = false
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) break
    const project = await db.collection(`${prefix}projects`).findOne({ id: 'PRJ-BACKSTOP-TEST' })
    const company = await db.collection(`${prefix}subscriptions`).findOne({ id: 'SUB-COMPANY-BACKSTOP-PRJ-BACKSTOP-TEST' })
    if (project?.companyBackstopShares === 1 && company) { settled = true; break }
    await delay(100)
  }
  assert.ok(settled, '到期后自动兜底已执行')
  const project = await db.collection(`${prefix}projects`).findOne({ id: 'PRJ-BACKSTOP-TEST' })
  assert.equal(project?.companyTakeoverAmount, 100)
  assert.equal(project?.employeeSubscribedAmount, 100)
  assert.equal(project?.remain, 0)
  assert.equal((await db.collection(`${prefix}subscriptions`).findOne({ id: 'SUB-unpaid' }))?.pay, '已释放')
  assert.equal((await db.collection(`${prefix}subscriptions`).findOne({ id: 'SUB-pending' }))?.pay, '待复核')
  const company = await db.collection(`${prefix}subscriptions`).findOne({ id: 'SUB-COMPANY-BACKSTOP-PRJ-BACKSTOP-TEST' })
  assert.equal(company?.pay, '公司待出资')
  assert.equal(company?.shares, 1)
  assert.equal(await db.collection(`${prefix}subscriptions`).countDocuments({ companyKind: 'backstop' }), 1)
  assert.equal(await db.collection(`${prefix}fund_ledger`).countDocuments(), 0)
  await delay(100)
  for (const subscriptionId of ['SUB-unpaid', 'SUB-COMPANY-BACKSTOP-PRJ-BACKSTOP-TEST']) {
    const form = new FormData()
    form.set('subscriptionId', subscriptionId)
    form.set('image', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), 'test.png')
    const response = await fetch(`http://127.0.0.1:${port}/api/payments/ocr`, {
      method: 'POST', headers: { 'X-User-Id': subscriptionId === 'SUB-unpaid' ? 'employee-unpaid' : 'company', 'X-User-Role': 'employee' }, body: form
    })
    const payload = await response.json()
    assert.equal(response.status, 409, JSON.stringify(payload))
    assert.equal(payload.error, 'PAYMENT_NOT_UPLOADABLE')
  }
  process.stdout.write('公司自动兜底隔离接口测试通过\n')
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await Promise.race([new Promise(resolve => child!.once('exit', resolve)), delay(5000)])
  }
  for (const name of names) {
    if (await db.listCollections({ name }, { nameOnly: true }).hasNext()) await db.collection(name).drop()
  }
  await client.close()
}
