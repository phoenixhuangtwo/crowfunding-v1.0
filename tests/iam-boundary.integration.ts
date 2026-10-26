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
  await db.collection(`${prefix}agreement_versions`).insertOne({
    id: 'AGREEMENT-IAM-TEST', version: 1, title: 'IAM 隔离测试协议',
    body: '员工独立承担税费，分配金额为税前金额；客户退货与坏账由公司承担，采购失败缺口由公司承担；预估收益不构成承诺。',
    effectiveAt: new Date().toISOString(), createdBy: 'integration-test'
  })
  await db.collection(`${prefix}projects`).insertOne({
    id: 'PRJ-IAM-TEST', title: 'IAM 隔离测试项目', source: 'integration-test',
    status: '未满额', statusType: 'primary', progress: 0, remain: 300, deadline: '2099-12-31 23:59',
    total: 300, costAmount: 300, salesAmount: 360, profitAmount: 60,
    companyFixedAmount: 0, companyTakeoverAmount: 0, companyForcedTakeoverAmount: 0,
    employeeSubscribedAmount: 0, subscribed: 0, people: 0
  })
  await db.collection(`${prefix}projects`).insertOne({
    id: 'PRJ-IAM-PUBLISH', title: '待发布归属测试项目', source: 'integration-test',
    status: '未开放', statusType: 'info', progress: 0, remain: 300, deadline: '2099-12-31 23:59',
    total: 300, costAmount: 300, salesAmount: 360, profitAmount: 60,
    companyFixedAmount: 0, companyTakeoverAmount: 0, companyForcedTakeoverAmount: 0,
    employeeSubscribedAmount: 0, subscribed: 0, people: 0
  })
  await db.collection(`${prefix}projects`).insertOne({
    id: 'PRJ-IAM-EXPIRED', title: '过期认购项目', source: 'integration-test',
    status: '未满额', statusType: 'primary', progress: 0, remain: 300, deadline: '2020-01-01 00:00',
    total: 300, costAmount: 300, salesAmount: 360, profitAmount: 60,
    companyFixedAmount: 0, companyTakeoverAmount: 0, companyForcedTakeoverAmount: 0,
    employeeSubscribedAmount: 0, subscribed: 0, people: 0
  })
  await db.collection(`${prefix}projects`).insertOne({
    id: 'PRJ-IAM-ADMIN-DRAFT', title: '管理员待发布项目', source: 'integration-test',
    status: '未开放', statusType: 'info', progress: 0, remain: 300, deadline: '2099-12-31 23:59',
    total: 300, costAmount: 300, salesAmount: 360, profitAmount: 60,
    companyFixedAmount: 0, companyTakeoverAmount: 0, companyForcedTakeoverAmount: 0,
    employeeSubscribedAmount: 0, subscribed: 0, people: 0
  })
  for (const [id, ownerUserId] of [['PRJ-IAM-ADMIN-OWN', '1002'], ['PRJ-IAM-ADMIN-OTHER', '1999']]) {
    await db.collection(`${prefix}projects`).insertOne({
      id, title: id, source: 'integration-test', tenantId: '0', ownerUserId, ownerDeptId: '200',
      status: '未满额', statusType: 'primary', progress: 0, remain: 300, deadline: '2099-12-31 23:59',
      total: 300, costAmount: 300, salesAmount: 360, profitAmount: 60,
      companyFixedAmount: 0, companyTakeoverAmount: 0, companyForcedTakeoverAmount: 0,
      employeeSubscribedAmount: 0, subscribed: 0, people: 0
    })
  }
  await db.collection(`${prefix}subscription_rules`).insertOne({
    id: 'RULE-IAM-PUBLISH', projectId: 'PRJ-IAM-PUBLISH', projectName: '待发布归属测试项目', ruleName: '隔离发布规则',
    totalAmount: 300, companyFixedAmount: 0, minAmount: 100, minParticipants: 1,
    allowMultiple: true, companyTakeover: false, status: '已启用', startAt: '', endAt: '2099-12-31 23:59', updatedAt: new Date().toISOString()
  })
  for (const [id, projectId, ownerUserId] of [
    ['RULE-IAM-ADMIN-OWN', 'PRJ-IAM-ADMIN-OWN', '1002'],
    ['RULE-IAM-ADMIN-OTHER', 'PRJ-IAM-ADMIN-OTHER', '1999']
  ]) {
    await db.collection(`${prefix}subscription_rules`).insertOne({
      id, projectId, projectName: projectId, tenantId: '0', ownerUserId, ownerDeptId: '200',
      ruleName: id, totalAmount: 300, companyFixedAmount: 0, minAmount: 100, minParticipants: 1,
      allowMultiple: true, companyTakeover: false, status: '已启用', startAt: '', endAt: '2099-12-31 23:59', updatedAt: new Date().toISOString()
    })
  }
  await db.collection(`${prefix}receiving_codes`).insertOne({
    id: 'RCV-IAM-ADMIN', subject: '测试收款主体', accountNote: '隔离测试', codeName: '测试收款码',
    status: '启用', updatedBy: 'integration-test', updatedAt: new Date().toISOString()
  })
  for (const [id, projectId] of [['SUB-IAM-ADMIN-OWN', 'PRJ-IAM-ADMIN-OWN'], ['SUB-IAM-ADMIN-OTHER', 'PRJ-IAM-ADMIN-OTHER']]) {
    await db.collection(`${prefix}subscriptions`).insertOne({
      id, projectId, project: projectId, userId: '2001', amount: 100, shares: 1, pay: '已缴款', profit: 20,
      action: '查看支付', idempotencyKey: id, createdAt: new Date().toISOString(), paymentDeadlineAt: '2099-12-31 23:59',
      paymentImages: [{ id: 'PRIVATE-IMAGE', assetId: 'PRIVATE-ASSET', paymentImageName: 'private.png', recognizedAmount: 100, uploadedAt: new Date().toISOString(), status: '已识别' }]
    })
  }
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['--import', 'tsx', 'server/server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env, API_PORT: String(port), NODE_ENV: 'test', MONGODB_COLLECTION_PREFIX: prefix,
      IAM_BASE_URL: fake.url, IAM_WEB_URL: fake.url, IAM_CLIENT_ID: 'crowdfunding', IAM_CLIENT_SECRET: 'smoke-only-client-secret',
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
  const employeeProjects = await request('/api/projects', employee)
  assert.equal(employeeProjects.status, 200)
  assert.deepEqual((employeeProjects.body.data as Array<{ id: string }>).map(project => project.id).sort(),
    ['PRJ-IAM-ADMIN-OTHER', 'PRJ-IAM-ADMIN-OWN', 'PRJ-IAM-TEST'])
  const departmentAdmin = await request('/api/projects', { Authorization: 'Bearer smoke-admin-token' })
  assert.equal(departmentAdmin.status, 200)
  assert.deepEqual((departmentAdmin.body.data as Array<{ id: string }>).map(project => project.id).sort(),
    ['PRJ-IAM-ADMIN-DRAFT', 'PRJ-IAM-ADMIN-OWN', 'PRJ-IAM-PUBLISH'])
  const admin = { Authorization: 'Bearer smoke-admin-token' }
  const adminRules = await request('/api/rules', admin)
  assert.equal(adminRules.status, 200)
  assert.deepEqual((adminRules.body.data as Array<{ id: string }>).map(rule => rule.id), ['RULE-IAM-ADMIN-OWN'])
  const adminSubscriptions = await request('/api/subscriptions', admin)
  assert.equal(adminSubscriptions.status, 200)
  assert.deepEqual((adminSubscriptions.body.data as Array<{ id: string }>).map(record => record.id), ['SUB-IAM-ADMIN-OWN'])
  assert.equal('paymentImages' in (adminSubscriptions.body.data as Record<string, unknown>[])[0]!, false)
  assert.equal((await request('/api/receiving-codes', admin)).status, 200)
  assert.equal((await request('/api/state', admin)).status, 403)
  assert.equal((await request('/api/state', { Authorization: 'Bearer smoke-admin-full-token' })).status, 403)
  assert.equal((await request('/api/audit-logs', { Authorization: 'Bearer smoke-admin-full-token' })).status, 403)
  assert.equal((await request('/api/risk-events', { Authorization: 'Bearer smoke-admin-full-token' })).status, 403)
  const postAs = async (path: string, token: string, body: Record<string, unknown>) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  const draftRule = { projectId: 'PRJ-IAM-ADMIN-DRAFT', ruleName: '管理员隔离测试规则', receivingCodeId: 'RCV-IAM-ADMIN',
    companyFixedAmount: 0, minParticipants: 1, status: '未启用', endAt: '2099-12-31 23:59' }
  assert.equal((await postAs('/api/settlements/calc', 'smoke-admin-full-token', {})).status, 403)
  assert.equal((await postAs('/api/rules', 'smoke-admin-token', draftRule)).status, 403)
  const createdRule = await postAs('/api/rules', 'smoke-admin-full-token', draftRule)
  assert.equal(createdRule.status, 201)
  const newRuleId = (createdRule.body.data as { id: string }).id
  assert.equal((await db.collection(`${prefix}subscription_rules`).findOne({ id: newRuleId }))?.ownerUserId, '1002')
  assert.equal((await postAs('/api/rules/RULE-IAM-ADMIN-OTHER/update', 'smoke-admin-full-token', draftRule)).status, 404)
  assert.equal((await postAs('/api/projects/PRJ-IAM-ADMIN-DRAFT/open', 'smoke-admin-full-token', { ruleId: 'RULE-IAM-ADMIN-OTHER' })).status, 404)
  assert.equal((await postAs(`/api/rules/${newRuleId}/status`, 'smoke-admin-full-token', { status: '已启用' })).status, 200)
  assert.equal((await postAs('/api/projects/PRJ-IAM-ADMIN-DRAFT/open', 'smoke-admin-full-token', { ruleId: newRuleId })).status, 200)
  assert.equal((await db.collection(`${prefix}projects`).findOne({ id: 'PRJ-IAM-ADMIN-DRAFT' }))?.ownerUserId, '1002')
  assert.equal((await postAs('/api/projects/PRJ-IAM-ADMIN-OTHER/interrupt', 'smoke-admin-full-token', { reason: '越权测试' })).status, 404)
  const outsideScope = await request('/api/projects', { Authorization: 'Bearer smoke-admin-outside-scope-token' })
  assert.equal(outsideScope.status, 403)
  assert.equal(outsideScope.body.error, 'DATA_SCOPE_MIGRATION_REQUIRED')
  assert.equal((await request('/api/projects', { Authorization: 'Bearer smoke-finance-token' })).status, 200)
  const published = await fetch(`${base}/api/projects/PRJ-IAM-PUBLISH/open`, {
    method: 'POST', headers: { Authorization: 'Bearer smoke-super-admin-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ruleId: 'RULE-IAM-PUBLISH' })
  })
  assert.equal(published.status, 200)
  const publishedProject = await db.collection(`${prefix}projects`).findOne({ id: 'PRJ-IAM-PUBLISH' })
  assert.equal(publishedProject?.tenantId, '0')
  assert.equal(publishedProject?.ownerUserId, '1004')
  assert.equal(publishedProject?.ownerDeptId, '900')
  assert.equal((await db.collection(`${prefix}projects`).findOne({ id: 'PRJ-IAM-TEST' }))?.ownerUserId, undefined)
  const legacyPost = async (path: string, token: string) => fetch(`${base}${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageDataUrl: 'data:image/png;base64,aGVsbG8=' })
  })
  assert.equal((await legacyPost('/api/payments/ocr', 'smoke-employee-token')).status, 415)
  assert.equal((await legacyPost('/api/invoices/ocr', 'smoke-finance-token')).status, 415)
  const subscribe = async (version: number, userId?: string) => {
    const response = await fetch(`${base}/api/subscriptions`, {
      method: 'POST', headers: { ...employee, 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'PRJ-IAM-TEST', amount: 100, idempotencyKey: `iam-sub-${version}-${userId ?? 'self'}`,
        agreementVersion: version, agreementsConfirmed: true, ...(userId ? { userId } : {}) })
    })
    return { status: response.status, body: await response.json() as Record<string, unknown> }
  }
  assert.equal((await subscribe(1, 'employee01')).status, 403)
  assert.equal((await subscribe(2)).status, 409)
  assert.equal(await db.collection(`${prefix}subscriptions`).countDocuments(), 2)
  const subscribed = await subscribe(1)
  assert.equal(subscribed.status, 201)
  assert.equal((await db.collection(`${prefix}subscriptions`).findOne({ idempotencyKey: 'iam-sub-1-self' }))?.userId, '1001')
  assert.equal((await db.collection(`${prefix}subscriptions`).findOne({ idempotencyKey: 'iam-sub-1-self' }))?.userName, '员工甲')
  assert.equal((await db.collection(`${prefix}agreement_confirmations`).findOne({ userId: '1001', node: '提交认购' }))?.version, 1)
  assert.equal((await db.collection(`${prefix}agreement_confirmations`).findOne({ userId: '1001', node: '提交认购' }))?.userName, '员工甲')
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
