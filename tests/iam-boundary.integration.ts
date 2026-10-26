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
  await db.collection(`${prefix}projects`).insertOne({
    id: 'PRJ-IAM-CONFLICT', title: '事务冲突测试项目', source: 'integration-test',
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
    totalAmount: 300, companyFixedAmount: 0, sharePrice: 100, totalShares: 3, companyFrontShares: 0,
    maxSharesPerEmployee: 1, minAmount: 100, minParticipants: 1,
    allowMultiple: true, companyTakeover: false, status: '已启用', startAt: '', endAt: '2099-12-31 23:59',
    paymentCutoffAt: '2100-01-01 12:00', plannedPaymentDate: '2100-01-02', updatedAt: new Date().toISOString()
  })
  for (const [id, projectId, ownerUserId] of [
    ['RULE-IAM-ADMIN-OWN', 'PRJ-IAM-ADMIN-OWN', '1002'],
    ['RULE-IAM-ADMIN-OTHER', 'PRJ-IAM-ADMIN-OTHER', '1999'],
    ['RULE-IAM-CONFLICT', 'PRJ-IAM-CONFLICT', '1002']
  ]) {
    await db.collection(`${prefix}subscription_rules`).insertOne({
      id, projectId, projectName: projectId, tenantId: '0', ownerUserId, ownerDeptId: '200',
      ruleName: id, totalAmount: 300, companyFixedAmount: 0, minAmount: 100, minParticipants: 1,
      allowMultiple: true, companyTakeover: false, status: '已启用', startAt: '', endAt: '2099-12-31 23:59',
      paymentCutoffAt: '2100-01-01 12:00', plannedPaymentDate: '2100-01-02', updatedAt: new Date().toISOString()
    })
  }
  await db.collection(`${prefix}subscription_rules`).updateOne({ id: 'RULE-IAM-CONFLICT' }, { $set: {
    totalAmount: 200, companyFixedAmount: 100, sharePrice: 100, totalShares: 3,
    companyFrontShares: 1, maxSharesPerEmployee: 1
  } })
  await db.collection(`${prefix}subscriptions`).insertOne({
    id: 'SUB-COMPANY-FRONT-PRJ-IAM-CONFLICT', projectId: 'PRJ-IAM-CONFLICT', userId: 'company',
    pay: '公司待出资', amount: 100
  })
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
    ['PRJ-IAM-ADMIN-DRAFT', 'PRJ-IAM-ADMIN-OWN', 'PRJ-IAM-CONFLICT', 'PRJ-IAM-PUBLISH'])
  const admin = { Authorization: 'Bearer smoke-admin-token' }
  const adminRules = await request('/api/rules', admin)
  assert.equal(adminRules.status, 200)
  assert.deepEqual((adminRules.body.data as Array<{ id: string }>).map(rule => rule.id).sort(),
    ['RULE-IAM-ADMIN-OWN', 'RULE-IAM-CONFLICT'])
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
    sharePrice: 100, companyFrontShares: 1, maxSharesPerEmployee: 1,
    minParticipants: 1, status: '未启用', endAt: '2099-12-31 23:59',
    paymentCutoffAt: '2100-01-01 12:00', plannedPaymentDate: '2100-01-02' }
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
  const front = await db.collection(`${prefix}subscriptions`).findOne({ id: 'SUB-COMPANY-FRONT-PRJ-IAM-ADMIN-DRAFT' })
  assert.equal(front?.amount, 100)
  assert.equal(front?.shares, 1)
  assert.equal(front?.companyKind, 'front')
  assert.equal(front?.pay, '公司待出资')
  assert.equal(front?.paymentDeadlineAt, draftRule.paymentCutoffAt)
  assert.equal(await db.collection(`${prefix}fund_ledger`).countDocuments(), 0)
  const funding = await request('/api/projects/PRJ-IAM-ADMIN-DRAFT/funding-reconciliation',
    { Authorization: 'Bearer smoke-finance-token' })
  assert.equal(funding.status, 200)
  const fundingData = funding.body.data as { purchaseCents: number; employeeCents: number;
    companyCents: number; differenceCents: number; balanced: boolean; companyFundsConfirmed: boolean }
  assert.equal(fundingData.purchaseCents, 30000)
  assert.equal(fundingData.employeeCents, 0)
  assert.equal(fundingData.companyCents, 10000)
  assert.equal(fundingData.differenceCents, -20000)
  assert.equal(fundingData.balanced, false)
  assert.equal(fundingData.companyFundsConfirmed, false)
  assert.equal((await request('/api/projects/PRJ-IAM-ADMIN-DRAFT/funding-reconciliation',
    { Authorization: 'Bearer smoke-employee-token' })).status, 403)
  await db.collection(`${prefix}fund_ledger`).insertOne({
    id: 'LED-ORPHAN', sourceKey: 'contribution:ORPHAN', type: 'employee_contribution',
    projectId: 'PRJ-IAM-ADMIN-DRAFT', subscriptionId: 'ORPHAN', participantId: '1001',
    shares: 1, amountCents: 10000, transactionNo: 'ORPHAN-TEST', transactionKey: 'ORPHAN-TEST',
    proofAssetIds: [], reviewedBy: 'test', createdAt: new Date().toISOString()
  })
  assert.equal((await request('/api/projects/PRJ-IAM-ADMIN-DRAFT/funding-reconciliation',
    { Authorization: 'Bearer smoke-finance-token' })).status, 409)
  await db.collection(`${prefix}fund_ledger`).deleteOne({ id: 'LED-ORPHAN' })
  assert.equal((await postAs('/api/projects/PRJ-IAM-ADMIN-DRAFT/open', 'smoke-admin-full-token', { ruleId: newRuleId })).status, 409)
  assert.equal(await db.collection(`${prefix}subscriptions`).countDocuments({ companyKind: 'front' }), 1)
  const conflict = await postAs('/api/projects/PRJ-IAM-CONFLICT/open', 'smoke-admin-full-token', { ruleId: 'RULE-IAM-CONFLICT' })
  assert.equal(conflict.status, 409)
  assert.equal(conflict.body.error, 'PROJECT_PUBLISH_CONFLICT')
  assert.equal((await db.collection(`${prefix}projects`).findOne({ id: 'PRJ-IAM-CONFLICT' }))?.status, '未开放')
  assert.equal(await db.collection(`${prefix}audit_logs`).countDocuments({ target: 'PRJ-IAM-CONFLICT' }), 0)
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
  assert.equal(await db.collection(`${prefix}subscriptions`).countDocuments(), 4)
  const subscribed = await subscribe(1)
  assert.equal(subscribed.status, 201)
  assert.equal((await db.collection(`${prefix}subscriptions`).findOne({ idempotencyKey: 'iam-sub-1-self' }))?.userId, '1001')
  assert.equal((await db.collection(`${prefix}subscriptions`).findOne({ idempotencyKey: 'iam-sub-1-self' }))?.userName, '员工甲')
  assert.equal((await db.collection(`${prefix}agreement_confirmations`).findOne({ userId: '1001', node: '提交认购' }))?.version, 1)
  assert.equal((await db.collection(`${prefix}agreement_confirmations`).findOne({ userId: '1001', node: '提交认购' }))?.userName, '员工甲')
  const publishedSubscription = await postAs('/api/subscriptions', 'smoke-employee-token', {
    projectId: 'PRJ-IAM-PUBLISH', shares: 1, idempotencyKey: 'iam-published-share',
    agreementVersion: 1, agreementsConfirmed: true
  })
  assert.equal(publishedSubscription.status, 201)
  const publishedRecord = await db.collection(`${prefix}subscriptions`).findOne({ idempotencyKey: 'iam-published-share' })
  assert.equal(publishedRecord?.shares, 1)
  assert.equal(Date.parse(`${String(publishedRecord?.paymentDeadlineAt).replace(' ', 'T')}+08:00`)
    - Date.parse(`${String(publishedRecord?.createdAt).replace(' ', 'T')}+08:00`), 12 * 60 * 60 * 1000)
  assert.ok(String(publishedRecord?.paymentDeadlineAt) <= '2100-01-01 12:00')
  assert.equal((await request('/api/state', employee)).status, 403)
  assert.equal((await request('/api/projects', { Authorization: 'Bearer smoke-no-access-token' })).status, 403)
  assert.equal((await request('/api/projects', { Authorization: 'Bearer smoke-iam-outage-token' })).status, 503)
  assert.equal((await request('/api/unregistered', employee)).status, 404)
  const me = await request('/api/auth/me', employee)
  assert.equal(me.status, 200)
  assert.equal((me.body.data as { user: { id: string } }).user.id, '1001')
  await db.collection(`${prefix}projects`).insertOne({
    id: 'PRJ-IAM-PAY-READY', title: '采购付款隔离测试项目', source: 'integration-test',
    status: '已满额', statusType: 'success', progress: 100, remain: 0, deadline: '2020-01-01 00:00',
    total: 200, costAmount: 300, salesAmount: 360, profitAmount: 60,
    companyFixedAmount: 100, companyTakeoverAmount: 0, companyForcedTakeoverAmount: 0,
    employeeSubscribedAmount: 200, subscribed: 300, people: 1, ruleId: 'RULE-IAM-PAY-READY'
  })
  await db.collection(`${prefix}subscription_rules`).insertOne({
    id: 'RULE-IAM-PAY-READY', projectId: 'PRJ-IAM-PAY-READY', ruleName: '采购付款隔离规则',
    sharePrice: 100, totalShares: 3, companyFrontShares: 1, totalAmount: 200,
    companyFixedAmount: 100, paymentCutoffAt: '2020-01-02 00:00',
    status: '已启用', updatedAt: '2020-01-01 00:00'
  })
  for (const record of [
    { id: 'SUB-IAM-PAY-COMPANY', userId: 'company', companyKind: 'front', amount: 100, shares: 1, pay: '公司待出资' },
    { id: 'SUB-IAM-PAY-EMPLOYEE', userId: '1001', amount: 200, shares: 2, pay: '已缴款' }
  ]) await db.collection(`${prefix}subscriptions`).insertOne({ ...record, projectId: 'PRJ-IAM-PAY-READY',
    project: '采购付款隔离测试项目', action: '查看支付', idempotencyKey: record.id,
    createdAt: '2020-01-01 00:00', paymentDeadlineAt: '2020-01-02 00:00' })
  await db.collection(`${prefix}fund_ledger`).insertOne({
    id: 'LED-IAM-PAY-EMPLOYEE', sourceKey: 'contribution:SUB-IAM-PAY-EMPLOYEE', type: 'employee_contribution',
    projectId: 'PRJ-IAM-PAY-READY', subscriptionId: 'SUB-IAM-PAY-EMPLOYEE', participantId: '1001',
    shares: 2, amountCents: 20000, transactionNo: 'BANK-IAM-EMPLOYEE',
    transactionKey: 'BANK-IAM-EMPLOYEE', proofAssetIds: [], reviewedBy: '1003', createdAt: '2020-01-01 00:00'
  })
  await db.collection(`${prefix}file_assets`).insertOne({
    id: 'ASSET-IAM-PAY', provider: 'tencent-cos', bucket: 'test', region: 'test',
    objectKey: 'test/procurement-payment-proof/ASSET-IAM-PAY.png', originalName: 'payment.png',
    extension: 'png', mimeType: 'image/png', sizeBytes: 8, sha256: 'a'.repeat(64),
    purpose: 'procurement-payment-proof', ownerType: 'project', ownerId: 'PRJ-IAM-PAY-READY',
    status: 'ready', createdBy: '1003', createdAt: '2020-01-01 00:00', updatedAt: '2020-01-01 00:00'
  })
  const paymentInput = { amountCents: 30000, transactionNo: 'BANK-IAM-PURCHASE',
    paidAt: new Date(Date.now() - 60_000).toISOString(), proofAssetIds: ['ASSET-IAM-PAY'],
    recognitionFailed: true, companyFundsConfirmed: true, note: '凭证识别未通过，财务已线下核对银行流水' }
  assert.equal((await postAs('/api/projects/PRJ-IAM-PAY-READY/procurement-payment',
    'smoke-employee-token', paymentInput)).status, 403)
  assert.equal((await postAs('/api/projects/PRJ-IAM-PAY-READY/procurement-payment',
    'smoke-finance-token', { ...paymentInput, companyFundsConfirmed: false })).status, 400)
  assert.equal((await postAs('/api/projects/PRJ-IAM-PAY-READY/procurement-payment',
    'smoke-finance-token', { ...paymentInput, proofAssetIds: ['ASSET-OTHER'] })).status, 409)
  assert.equal((await postAs('/api/projects/PRJ-IAM-PAY-READY/procurement-payment',
    'smoke-finance-token', { ...paymentInput, transactionNo: 'BANK-IAM-EMPLOYEE' })).status, 400)
  assert.equal((await postAs('/api/projects/PRJ-IAM-PAY-READY/procurement-payment',
    'smoke-finance-token', { ...paymentInput, recognitionFailed: false })).status, 409)
  assert.equal(await db.collection(`${prefix}procurement_payments`).countDocuments(), 0)
  const paid = await postAs('/api/projects/PRJ-IAM-PAY-READY/procurement-payment',
    'smoke-finance-token', paymentInput)
  assert.equal(paid.status, 201, JSON.stringify(paid.body))
  assert.equal((await db.collection(`${prefix}projects`).findOne({ id: 'PRJ-IAM-PAY-READY' }))?.status, '待回款')
  assert.equal((await db.collection(`${prefix}subscriptions`).findOne({ id: 'SUB-IAM-PAY-COMPANY' }))?.pay, '已缴款')
  assert.equal(await db.collection(`${prefix}fund_ledger`).countDocuments({ projectId: 'PRJ-IAM-PAY-READY' }), 3)
  const lockedImage = new FormData()
  lockedImage.set('subscriptionId', 'SUB-IAM-PAY-EMPLOYEE')
  lockedImage.set('image', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), 'locked.png')
  const lockedUpload = await fetch(`${base}/api/payments/ocr`, {
    method: 'POST', headers: { Authorization: 'Bearer smoke-employee-token' }, body: lockedImage
  })
  const lockedPayload = await lockedUpload.json() as { error: string; message?: string }
  assert.equal(lockedUpload.status, 409, JSON.stringify(lockedPayload))
  assert.equal(lockedPayload.error, 'SUBSCRIPTION_LOCKED')
  assert.equal((await postAs('/api/projects/PRJ-IAM-PAY-READY/procurement-payment',
    'smoke-finance-token', paymentInput)).status, 409)
  assert.equal(await db.collection(`${prefix}procurement_payments`).countDocuments(), 1)
  const paidFunding = await request('/api/projects/PRJ-IAM-PAY-READY/funding-reconciliation',
    { Authorization: 'Bearer smoke-finance-token' })
  assert.equal((paidFunding.body.data as { companyFundsConfirmed: boolean }).companyFundsConfirmed, true)
  for (const id of ['ASSET-IAM-TOPUP', 'ASSET-IAM-CUSTOMER', 'ASSET-IAM-EXCESS']) {
    await db.collection(`${prefix}file_assets`).insertOne({
      id, provider: 'tencent-cos', bucket: 'test', region: 'test',
      objectKey: `test/customer-receipt-proof/${id}.png`, originalName: `${id}.png`,
      extension: 'png', mimeType: 'image/png', sizeBytes: 8, sha256: 'b'.repeat(64),
      purpose: 'customer-receipt-proof', ownerType: 'project', ownerId: 'PRJ-IAM-PAY-READY',
      status: 'ready', createdBy: '1003', createdAt: '2020-01-01 00:00', updatedAt: '2020-01-01 00:00'
    })
  }
  const receiptBase = { bookedAt: new Date(Date.now() - 120_000).toISOString(),
    recognitionFailed: true, note: '已对照银行流水及付款凭证逐项人工核实' }
  const topupInput = { ...receiptBase, kind: '公司补款', transactionNo: 'BANK-IAM-TOPUP',
    totalCents: 16000, lines: [{ projectId: 'PRJ-IAM-PAY-READY', amountCents: 16000 }],
    proofAssetIds: ['ASSET-IAM-TOPUP'], reason: '客户欠款暂未结清，由公司先行补足' }
  assert.equal((await postAs('/api/receipt-batches', 'smoke-employee-token', topupInput)).status, 403)
  assert.equal((await postAs('/api/receipt-batches', 'smoke-finance-token', {
    ...topupInput, recognitionFailed: false })).status, 409)
  const topupCreated = await postAs('/api/receipt-batches', 'smoke-finance-token', topupInput)
  assert.equal(topupCreated.status, 201, JSON.stringify(topupCreated.body))
  assert.equal((await postAs('/api/receipt-batches', 'smoke-finance-token', topupInput)).status, 409,
    '相同银行流水不能重复登记')
  const topupId = (topupCreated.body.data as { id: string }).id
  assert.equal((await postAs(`/api/receipt-batches/${topupId}/review`, 'smoke-finance-token', {
    decision: '通过', actualBankCents: 16000, actualBankTransactionNo: 'BANK-IAM-TOPUP' })).status, 409)
  const topupReviewed = await postAs(`/api/receipt-batches/${topupId}/review`, 'smoke-super-admin-token', {
    decision: '通过', actualBankCents: 16000, actualBankTransactionNo: 'BANK-IAM-TOPUP' })
  assert.equal(topupReviewed.status, 200, JSON.stringify(topupReviewed.body))
  const customerInput = { ...receiptBase, kind: '客户回款', transactionNo: 'BANK-IAM-CUSTOMER',
    totalCents: 36000, lines: [{ projectId: 'PRJ-IAM-PAY-READY', amountCents: 36000 }],
    proofAssetIds: ['ASSET-IAM-CUSTOMER'] }
  const customerCreated = await postAs('/api/receipt-batches', 'smoke-finance-token', customerInput)
  assert.equal(customerCreated.status, 201, JSON.stringify(customerCreated.body))
  const customerId = (customerCreated.body.data as { id: string }).id
  assert.equal((await postAs(`/api/receipt-batches/${customerId}/review`, 'smoke-finance-token', {
    decision: '通过', actualBankCents: 35999, actualBankTransactionNo: 'BANK-IAM-CUSTOMER' })).status, 409)
  assert.equal((await postAs(`/api/receipt-batches/${customerId}/review`, 'smoke-super-admin-token', {
    decision: '通过', actualBankCents: 36000, actualBankTransactionNo: 'BANK-IAM-CUSTOMER' })).status, 409)
  const customerReviewed = await postAs(`/api/receipt-batches/${customerId}/review`, 'smoke-finance-token', {
    decision: '通过', actualBankCents: 36000, actualBankTransactionNo: 'BANK-IAM-CUSTOMER' })
  assert.equal(customerReviewed.status, 200, JSON.stringify(customerReviewed.body))
  assert.deepEqual((customerReviewed.body.data as { returns: unknown }).returns,
    [{ projectId: 'PRJ-IAM-PAY-READY', amountCents: 16000 }])
  assert.equal((await db.collection(`${prefix}projects`).findOne({ id: 'PRJ-IAM-PAY-READY' }))?.status, '待分配')
  const receiptSummary = await request('/api/projects/PRJ-IAM-PAY-READY/receipt-summary',
    { Authorization: 'Bearer smoke-finance-token' })
  assert.equal((receiptSummary.body.data as { distributableCents: number }).distributableCents, 36000)
  assert.equal(await db.collection(`${prefix}fund_ledger`).countDocuments({
    projectId: 'PRJ-IAM-PAY-READY', type: 'company_topup_return' }), 1)
  const excessInput = { ...receiptBase, kind: '客户回款', transactionNo: 'BANK-IAM-EXCESS',
    totalCents: 1000, lines: [{ projectId: 'PRJ-IAM-PAY-READY', amountCents: 1000 }],
    proofAssetIds: ['ASSET-IAM-EXCESS'] }
  const excessCreated = await postAs('/api/receipt-batches', 'smoke-finance-token', excessInput)
  assert.equal(excessCreated.status, 201, JSON.stringify(excessCreated.body))
  const excessId = (excessCreated.body.data as { id: string }).id
  assert.equal((await postAs(`/api/receipt-batches/${excessId}/review`, 'smoke-finance-token', {
    decision: '通过', actualBankCents: 1000, actualBankTransactionNo: 'BANK-IAM-EXCESS' })).status, 200)
  const differencePath = '/api/projects/PRJ-IAM-PAY-READY/receipt-differences'
  assert.equal((await postAs(differencePath, 'smoke-super-admin-token', {
    amountCents: 100, destination: '计入公司', reason: '公司收入确认' })).status, 403)
  assert.equal((await postAs(differencePath, 'smoke-finance-token', {
    amountCents: 1100, destination: '计入公司', reason: '超额测试记录' })).status, 400)
  assert.equal((await postAs(differencePath, 'smoke-finance-token', {
    amountCents: 400, destination: '退回客户', reason: '客户多付部分线下退回',
    refundTransactionNo: 'BANK-IAM-PURCHASE' })).status, 409)
  assert.equal((await postAs(differencePath, 'smoke-finance-token', {
    amountCents: 400, destination: '退回客户', reason: '客户多付部分线下退回',
    refundTransactionNo: 'BANK-IAM-REFUND' })).status, 201)
  assert.equal((await postAs(differencePath, 'smoke-finance-token', {
    amountCents: 600, destination: '计入公司', reason: '客户同意剩余金额归入公司' })).status, 201)
  const finalSummary = await request('/api/projects/PRJ-IAM-PAY-READY/receipt-summary',
    { Authorization: 'Bearer smoke-finance-token' })
  assert.equal((finalSummary.body.data as { unresolvedCents: number }).unresolvedCents, 0)
  assert.equal((finalSummary.body.data as { excessCents: number }).excessCents, 1000)
  await db.collection(`${prefix}file_assets`).insertOne({
    id: 'ASSET-IAM-COST', provider: 'tencent-cos', bucket: 'test', region: 'test',
    objectKey: 'test/confirmed-cost-proof/ASSET-IAM-COST.png', originalName: 'cost.png',
    extension: 'png', mimeType: 'image/png', sizeBytes: 8, sha256: 'c'.repeat(64),
    purpose: 'confirmed-cost-proof', ownerType: 'project', ownerId: 'PRJ-IAM-PAY-READY',
    status: 'ready', createdBy: '1003', createdAt: '2020-01-01 00:00', updatedAt: '2020-01-01 00:00'
  })
  const costInput = { projectId: 'PRJ-IAM-PAY-READY', amountCents: 100,
    transactionNo: 'BANK-IAM-COST', paidAt: new Date(Date.now() - 120_000).toISOString(),
    proofAssetIds: ['ASSET-IAM-COST'], reason: '客户订单额外物流支出' }
  assert.equal((await postAs('/api/confirmed-costs', 'smoke-employee-token', costInput)).status, 403)
  const costCreated = await postAs('/api/confirmed-costs', 'smoke-finance-token', costInput)
  assert.equal(costCreated.status, 201, JSON.stringify(costCreated.body))
  const costId = (costCreated.body.data as { id: string }).id
  assert.equal((await postAs('/api/projects/PRJ-IAM-PAY-READY/distribution-orders',
    'smoke-finance-token', {})).status, 409, '待复核成本阻止生成分配单')
  assert.equal((await postAs(`/api/confirmed-costs/${costId}/review`, 'smoke-finance-token', {
    decision: '通过' })).status, 403)
  assert.equal((await postAs(`/api/confirmed-costs/${costId}/review`, 'smoke-super-admin-token', {
    decision: '通过' })).status, 200)
  assert.equal(await db.collection(`${prefix}fund_ledger`).countDocuments({ type: 'other_confirmed_cost',
    projectId: 'PRJ-IAM-PAY-READY' }), 1)
  const distributionCreated = await postAs('/api/projects/PRJ-IAM-PAY-READY/distribution-orders',
    'smoke-finance-token', {})
  assert.equal(distributionCreated.status, 201, JSON.stringify(distributionCreated.body))
  const order = distributionCreated.body.data as { id: string; status: string; payoutTotalCents: number;
    profitCents: number; lines: Array<{ kind: string; shares: number }> }
  assert.equal(order.status, '待审批')
  assert.equal(order.payoutTotalCents, 35900)
  assert.equal(order.profitCents, 5900)
  assert.deepEqual(order.lines.map(line => [line.kind, line.shares]), [['employee', 2], ['company', 1]])
  assert.equal((await postAs(`/api/distribution-orders/${order.id}/approve`, 'smoke-finance-token', {})).status, 403,
    '采购付款登记人不能审批分配单')
  const distributionApproved = await postAs(`/api/distribution-orders/${order.id}/approve`,
    'smoke-second-finance-token', {})
  assert.equal(distributionApproved.status, 200, JSON.stringify(distributionApproved.body))
  assert.equal((distributionApproved.body.data as { status: string }).status, '已审批')
  assert.equal((await postAs(`/api/distribution-orders/${order.id}/void`, 'smoke-second-finance-token', {})).status, 409,
    '审批后不允许作废')
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
