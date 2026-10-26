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
    id: 'PRJ-IAM-OVERDUE-SWEEP', title: '超期回款定时触发项目', source: 'integration-test',
    status: '回款中', statusType: 'warning', progress: 100, remain: 0,
    deadline: '2020-01-01 00:00', total: 100, costAmount: 100, salesAmount: 120,
    profitAmount: 20, companyFixedAmount: 0, companyTakeoverAmount: 0,
    companyForcedTakeoverAmount: 0, employeeSubscribedAmount: 100,
    subscribed: 100, people: 1, purchasePaidAt: '2020-01-02T00:00:00.000Z',
    ruleParametersSnapshot: { paymentHours: 12, paymentReminderHours: 4,
      proxyConfirmDays: 7, receiptWarningDays: 30, issueHandlingHours: 72 }
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
  let sweptCase = null
  for (let attempt = 0; attempt < 30; attempt += 1) {
    sweptCase = await db.collection(`${prefix}receipt_overdue_cases`).findOne({
      projectId: 'PRJ-IAM-OVERDUE-SWEEP' })
    if (sweptCase) break
    await delay(100)
  }
  assert.equal(sweptCase?.status, '待处置')
  assert.equal(sweptCase?.gapCents, 12000)
  assert.equal(await db.collection(`${prefix}notifications`).countDocuments({
    recipientId: 'role:super_admin', projectId: 'PRJ-IAM-OVERDUE-SWEEP', type: '回款超期预警' }), 1)
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
  const globalRulesPath = '/api/rule-parameters'
  const company = { Authorization: 'Bearer smoke-super-admin-token' }
  assert.equal((await request(globalRulesPath, employee)).status, 403)
  assert.equal((await request(globalRulesPath, company)).body.data?.paymentHours, 12)
  const changedRules = { paymentHours: 24, paymentReminderHours: 6, proxyConfirmDays: 9,
    receiptWarningDays: 31, issueHandlingHours: 80 }
  assert.equal((await postAs(globalRulesPath, 'smoke-finance-token', changedRules)).status, 403)
  assert.equal((await postAs(globalRulesPath, 'smoke-super-admin-token',
    { ...changedRules, paymentHours: 0 })).status, 400)
  assert.equal((await postAs(globalRulesPath, 'smoke-super-admin-token', changedRules)).status, 200)
  assert.equal((await db.collection(`${prefix}rule_parameters`).findOne({ id: 'global' }))?.revision, 1)
  const published = await fetch(`${base}/api/projects/PRJ-IAM-PUBLISH/open`, {
    method: 'POST', headers: { Authorization: 'Bearer smoke-super-admin-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ruleId: 'RULE-IAM-PUBLISH' })
  })
  assert.equal(published.status, 200)
  const publishedProject = await db.collection(`${prefix}projects`).findOne({ id: 'PRJ-IAM-PUBLISH' })
  assert.equal(publishedProject?.tenantId, '0')
  assert.equal(publishedProject?.ownerUserId, '1004')
  assert.equal(publishedProject?.ownerDeptId, '900')
  assert.deepEqual(publishedProject?.ruleParametersSnapshot, changedRules)
  assert.equal(publishedProject?.proxyConfirmDays, 9)
  assert.equal((await postAs(globalRulesPath, 'smoke-super-admin-token',
    { ...changedRules, paymentHours: 48, proxyConfirmDays: 10 })).status, 200)
  assert.deepEqual((await db.collection(`${prefix}projects`).findOne({ id: 'PRJ-IAM-PUBLISH' }))?.ruleParametersSnapshot,
    changedRules)
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
  const ownNotifications = await request('/api/notifications', employee)
  assert.equal(ownNotifications.status, 200)
  const ownNoticeItems = (ownNotifications.body.data as { items: Array<{ id: string; type: string }> }).items
  const ownNotice = ownNoticeItems.find(item => item.id.includes(String(publishedRecord?.id)))
  assert.equal(ownNotice?.type, '认购成功')
  const foreignNoticeId = '认购成功:SUB-FOREIGN:1002'
  await db.collection(`${prefix}notifications`).insertOne({ id: foreignNoticeId, recipientId: '1002',
    type: '认购成功', title: '认购成功', content: '他人通知', targetPage: 'mine', createdAt: new Date().toISOString() })
  assert.equal((await postAs(`/api/notifications/${encodeURIComponent(foreignNoticeId)}/read`,
    'smoke-employee-token', {})).status, 404)
  assert.equal((await db.collection(`${prefix}notifications`).findOne({ id: foreignNoticeId }))?.readAt, undefined)
  assert.equal((await postAs(`/api/notifications/${encodeURIComponent(ownNotice!.id)}/read`,
    'smoke-employee-token', {})).status, 200)
  assert.ok((await db.collection(`${prefix}notifications`).findOne({ id: ownNotice!.id }))?.readAt)
  assert.equal((await postAs('/api/notifications/read-all', 'smoke-employee-token', {})).status, 200)
  await db.collection(`${prefix}notifications`).insertOne({ id: '异议超时升级:DIST-TEST:1001:role:super_admin',
    recipientId: 'role:super_admin', type: '异议超时升级', title: '异议超时升级',
    content: '公司专属提醒', targetPage: 'distributionOrders', createdAt: new Date().toISOString() })
  const companyNotices = await request('/api/notifications', { Authorization: 'Bearer smoke-super-admin-token' })
  assert.equal(companyNotices.status, 200, JSON.stringify(companyNotices.body))
  const copiedNotice = (companyNotices.body.data as { items: Array<{ id: string }> }).items
    .find(item => item.id.includes('异议超时升级:DIST-TEST:1001'))
  assert.ok(copiedNotice)
  assert.equal((await request('/api/notifications', { Authorization: 'Bearer smoke-finance-token' })).status, 200)
  assert.equal(await db.collection(`${prefix}notifications`).countDocuments({
    recipientId: '1003', type: '异议超时升级' }), 0)
  assert.equal(Date.parse(`${String(publishedRecord?.paymentDeadlineAt).replace(' ', 'T')}+08:00`)
    - Date.parse(`${String(publishedRecord?.createdAt).replace(' ', 'T')}+08:00`), 24 * 60 * 60 * 1000)
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
  assert.equal(await db.collection(`${prefix}notifications`).countDocuments({
    type: '可生成分配单', recipientId: 'role:finance', projectId: 'PRJ-IAM-PAY-READY' }), 1)
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
  assert.equal(await db.collection(`${prefix}notifications`).countDocuments({
    type: '分配单生成', projectId: 'PRJ-IAM-PAY-READY',
    recipientId: { $in: ['role:finance', 'role:super_admin'] } }), 2)
  assert.equal((await postAs(`/api/distribution-orders/${order.id}/void`, 'smoke-second-finance-token', {})).status, 409,
    '审批后不允许作废')
  await db.collection(`${prefix}file_assets`).insertOne({
    id: 'ASSET-IAM-PAYOUT', provider: 'tencent-cos', bucket: 'test', region: 'test',
    objectKey: 'test/distribution-payout-proof/ASSET-IAM-PAYOUT.png', originalName: 'payout.png',
    extension: 'png', mimeType: 'image/png', sizeBytes: 8, sha256: 'd'.repeat(64),
    purpose: 'distribution-payout-proof', ownerType: 'subscription', ownerId: 'SUB-IAM-PAY-EMPLOYEE',
    status: 'ready', createdBy: '1008', createdAt: '2020-01-01 00:00', updatedAt: '2020-01-01 00:00'
  })
  const employeePayoutPath = `/api/distribution-orders/${order.id}/lines/1001/payout`
  const employeePayout = { amountCents: 23933, transactionNo: 'BANK-IAM-PAYOUT',
    paidAt: new Date(Date.now() - 60_000).toISOString(), proofAssetIds: ['ASSET-IAM-PAYOUT'],
    note: '已核对银行实际打款金额与上传凭证' }
  assert.equal((await postAs(employeePayoutPath, 'smoke-employee-token', employeePayout)).status, 403)
  assert.equal((await postAs(employeePayoutPath, 'smoke-second-finance-token', {
    ...employeePayout, amountCents: 23932 })).status, 400)
  const employeePaid = await postAs(employeePayoutPath, 'smoke-second-finance-token', employeePayout)
  assert.equal(employeePaid.status, 200, JSON.stringify(employeePaid.body))
  assert.equal(await db.collection(`${prefix}notifications`).countDocuments({
    type: '打款待确认', recipientId: '1001', projectId: order.projectId }), 1)
  assert.equal((await postAs(`/api/distribution-orders/${order.id}/lines/company/payout`,
    'smoke-finance-token', { amountCents: 11967, paidAt: employeePayout.paidAt,
      companyTransferConfirmed: true })).status, 200)
  const myPayouts = await request('/api/my-distribution-payouts', employee)
  assert.equal(myPayouts.status, 200)
  assert.equal((myPayouts.body.data as Array<{ line: { participantId: string; status: string } }>).length, 1)
  assert.equal((myPayouts.body.data as Array<{ line: { participantId: string; status: string } }>)[0].line.participantId, '1001')
  const confirmationPath = `/api/distribution-orders/${order.id}/lines/1001/confirm`
  assert.equal((await postAs(confirmationPath, 'smoke-employee-token', {
    decision: '异议', reason: '实际到账金额与登记记录不一致' })).status, 200)
  assert.equal((await db.collection(`${prefix}distribution_orders`).findOne({ id: order.id }))?.status, '有异议')
  assert.equal((await postAs(`/api/distribution-orders/${order.id}/lines/1001/issue-reply`,
    'smoke-finance-token', { reply: '已重新核对银行流水，登记金额与实际到账一致' })).status, 200)
  assert.equal(await db.collection(`${prefix}notifications`).countDocuments({
    type: '异议处理结果', recipientId: '1001', projectId: order.projectId }), 1)
  assert.equal((await postAs(`/api/distribution-orders/${order.id}/lines/1001/confirm`,
    'smoke-finance-token', { decision: '确认', agreementVersion: 1, agreementsConfirmed: true })).status, 403)
  const employeeConfirmed = await postAs(`/api/distribution-orders/${order.id}/lines/1001/confirm`,
    'smoke-employee-token', { decision: '确认', agreementVersion: 1, agreementsConfirmed: true })
  assert.equal(employeeConfirmed.status, 200, JSON.stringify(employeeConfirmed.body))
  assert.equal((await db.collection(`${prefix}distribution_orders`).findOne({ id: order.id }))?.status, '可结单')
  assert.equal(await db.collection(`${prefix}fund_ledger`).countDocuments({
    projectId: 'PRJ-IAM-PAY-READY', type: 'employee_distribution_payout' }), 1)
  const financialReconciliation = await request('/api/projects/PRJ-IAM-PAY-READY/financial-reconciliation',
    { Authorization: 'Bearer smoke-finance-token' })
  assert.equal(financialReconciliation.status, 200, JSON.stringify(financialReconciliation.body))
  assert.equal((financialReconciliation.body.data as { closeReady: boolean }).closeReady, true)
  await db.collection(`${prefix}file_assets`).insertOne({
    id: 'ASSET-IAM-EXCEPTION', provider: 'tencent-cos', bucket: 'test', region: 'test',
    objectKey: 'test/exception-fund-proof/ASSET-IAM-EXCEPTION.png', originalName: 'exception.png',
    extension: 'png', mimeType: 'image/png', sizeBytes: 8, sha256: 'e'.repeat(64),
    purpose: 'exception-fund-proof', ownerType: 'project', ownerId: 'exception-staging:1003',
    status: 'ready', createdBy: '1003', createdAt: '2020-01-01 00:00', updatedAt: '2020-01-01 00:00'
  })
  const exceptionInput = { projectId: 'PRJ-IAM-PAY-READY', amountCents: 250,
    transactionNo: 'BANK-IAM-EXCEPTION', bookedAt: new Date(Date.now() - 60_000).toISOString(),
    sourceNote: '付款人转错款项，暂未能匹配认购单', manualVerificationNote: '已人工核对银行流水与到账时间',
    proofAssetIds: ['ASSET-IAM-EXCEPTION'] }
  assert.equal((await postAs('/api/exception-funds', 'smoke-employee-token', exceptionInput)).status, 403)
  assert.equal((await postAs('/api/exception-funds', 'smoke-finance-token', {
    ...exceptionInput, manualVerificationNote: '' })).status, 400)
  const exceptionCreated = await postAs('/api/exception-funds', 'smoke-finance-token', exceptionInput)
  assert.equal(exceptionCreated.status, 201, JSON.stringify(exceptionCreated.body))
  assert.equal((await postAs('/api/exception-funds', 'smoke-finance-token', exceptionInput)).status, 409)
  const exceptionList = await request('/api/exception-funds?projectId=PRJ-IAM-PAY-READY',
    { Authorization: 'Bearer smoke-finance-token' })
  assert.equal(exceptionList.status, 200)
  assert.equal((exceptionList.body.data as { total: number }).total, 1)
  const blockedReconciliation = await request('/api/projects/PRJ-IAM-PAY-READY/financial-reconciliation',
    { Authorization: 'Bearer smoke-finance-token' })
  assert.equal((blockedReconciliation.body.data as { closeReady: boolean; unprocessedExceptionCents: number }).closeReady, false)
  assert.equal((blockedReconciliation.body.data as { unprocessedExceptionCents: number }).unprocessedExceptionCents, 250)
  assert.equal((await postAs(`/api/distribution-orders/${order.id}/close`,
    'smoke-finance-token', {})).status, 409, '未处理异常款项阻止结单')
  assert.equal(await db.collection(`${prefix}fund_ledger`).countDocuments({ type: 'exception_fund_received' }), 1)
  const fundId = (exceptionCreated.body.data as { id: string }).id
  await db.collection(`${prefix}file_assets`).insertOne({
    id: 'ASSET-IAM-EXCEPTION-REFUND', provider: 'tencent-cos', bucket: 'test', region: 'test',
    objectKey: 'test/exception-refund-proof/ASSET-IAM-EXCEPTION-REFUND.png', originalName: 'refund.png',
    extension: 'png', mimeType: 'image/png', sizeBytes: 8, sha256: 'f'.repeat(64),
    purpose: 'exception-refund-proof', ownerType: 'project',
    ownerId: `exception-refund-staging:${fundId}:1003`, status: 'ready', createdBy: '1003',
    createdAt: '2020-01-01 00:00', updatedAt: '2020-01-01 00:00'
  })
  const refundInput = { amountCents: 250, transactionNo: 'BANK-IAM-EX-REFUND',
    paidAt: new Date(Date.now() - 60_000).toISOString(), reason: '已向原付款人退回异常到账款项',
    proofAssetIds: ['ASSET-IAM-EXCEPTION-REFUND'] }
  assert.equal((await postAs(`/api/exception-funds/${fundId}/refunds`, 'smoke-employee-token', refundInput)).status, 403)
  const refundCreated = await postAs(`/api/exception-funds/${fundId}/refunds`, 'smoke-finance-token', refundInput)
  assert.equal(refundCreated.status, 201, JSON.stringify(refundCreated.body))
  assert.equal((await postAs(`/api/exception-funds/${fundId}/refunds`, 'smoke-finance-token', refundInput)).status, 400)
  const refundId = (refundCreated.body.data as { id: string }).id
  const refundConfirmPath = `/api/exception-funds/${fundId}/refunds/${refundId}/confirm`
  assert.equal((await postAs(refundConfirmPath, 'smoke-employee-token', {})).status, 403)
  assert.equal((await postAs(refundConfirmPath, 'smoke-super-admin-token', {})).status, 200)
  assert.equal((await postAs(refundConfirmPath, 'smoke-super-admin-token', {})).status, 409)
  const clearedReconciliation = await request('/api/projects/PRJ-IAM-PAY-READY/financial-reconciliation',
    { Authorization: 'Bearer smoke-finance-token' })
  assert.equal((clearedReconciliation.body.data as { closeReady: boolean }).closeReady, true)
  assert.equal(await db.collection(`${prefix}fund_ledger`).countDocuments({ type: 'exception_fund_refund_confirmed' }), 1)
  await db.collection(`${prefix}file_assets`).insertMany([
    { id: 'ASSET-IAM-EXCEPTION-EMPLOYEE', provider: 'tencent-cos', bucket: 'test', region: 'test',
      objectKey: 'test/exception-fund-proof/ASSET-IAM-EXCEPTION-EMPLOYEE.png', originalName: 'employee.png',
      extension: 'png', mimeType: 'image/png', sizeBytes: 8, sha256: 'a'.repeat(64),
      purpose: 'exception-fund-proof', ownerType: 'project', ownerId: 'exception-staging:1003',
      status: 'ready', createdBy: '1003', createdAt: '2020-01-01 00:00', updatedAt: '2020-01-01 00:00' },
    { id: 'ASSET-IAM-EXCEPTION-EMPLOYEE-REFUND', provider: 'tencent-cos', bucket: 'test', region: 'test',
      objectKey: 'test/exception-refund-proof/ASSET-IAM-EXCEPTION-EMPLOYEE-REFUND.png', originalName: 'employee-refund.png',
      extension: 'png', mimeType: 'image/png', sizeBytes: 8, sha256: 'b'.repeat(64),
      purpose: 'exception-refund-proof', ownerType: 'project', ownerId: 'pending',
      status: 'ready', createdBy: '1003', createdAt: '2020-01-01 00:00', updatedAt: '2020-01-01 00:00' }
  ])
  const employeeFundCreated = await postAs('/api/exception-funds', 'smoke-finance-token', {
    ...exceptionInput, payerUserId: '1001', amountCents: 125,
    transactionNo: 'BANK-IAM-EX-EMPLOYEE', proofAssetIds: ['ASSET-IAM-EXCEPTION-EMPLOYEE'] })
  assert.equal(employeeFundCreated.status, 201, JSON.stringify(employeeFundCreated.body))
  const employeeFundId = (employeeFundCreated.body.data as { id: string }).id
  await db.collection(`${prefix}file_assets`).updateOne({ id: 'ASSET-IAM-EXCEPTION-EMPLOYEE-REFUND' },
    { $set: { ownerId: `exception-refund-staging:${employeeFundId}:1003` } })
  const employeeRefundCreated = await postAs(`/api/exception-funds/${employeeFundId}/refunds`, 'smoke-finance-token', {
    ...refundInput, amountCents: 125, transactionNo: 'BANK-IAM-EX-EMPLOYEE-REFUND',
    proofAssetIds: ['ASSET-IAM-EXCEPTION-EMPLOYEE-REFUND'] })
  assert.equal(employeeRefundCreated.status, 201, JSON.stringify(employeeRefundCreated.body))
  const employeeRefundId = (employeeRefundCreated.body.data as { id: string }).id
  const myExceptionRefunds = await request('/api/my-exception-refunds', employee)
  assert.equal(myExceptionRefunds.status, 200)
  assert.equal((myExceptionRefunds.body.data as Array<{ fundId: string }>).length, 1)
  assert.equal((myExceptionRefunds.body.data as Array<{ fundId: string }>)[0].fundId, employeeFundId)
  const employeeRefundConfirmPath = `/api/exception-funds/${employeeFundId}/refunds/${employeeRefundId}/confirm`
  assert.equal((await postAs(employeeRefundConfirmPath, 'smoke-super-admin-token', {})).status, 403)
  assert.equal((await postAs(employeeRefundConfirmPath, 'smoke-employee-token', {})).status, 200)
  assert.equal((await postAs(employeeRefundConfirmPath, 'smoke-employee-token', {})).status, 409)
  assert.equal((await postAs(`/api/distribution-orders/${order.id}/close`,
    'smoke-employee-token', {})).status, 403)
  const closedOrder = await postAs(`/api/distribution-orders/${order.id}/close`, 'smoke-finance-token', {})
  assert.equal(closedOrder.status, 200, JSON.stringify(closedOrder.body))
  assert.equal((await db.collection(`${prefix}projects`).findOne({ id: 'PRJ-IAM-PAY-READY' }))?.status, '已完结')
  assert.equal((await db.collection(`${prefix}distribution_orders`).findOne({ id: order.id }))?.status, '已完成')
  assert.equal(await db.collection(`${prefix}notifications`).countDocuments({
    type: '已结单', recipientId: '1001', projectId: 'PRJ-IAM-PAY-READY' }), 1)
  assert.equal(await db.collection(`${prefix}notifications`).countDocuments({
    type: '已结单', recipientId: 'role:finance', projectId: 'PRJ-IAM-PAY-READY' }), 1)
  assert.equal((await postAs(`/api/distribution-orders/${order.id}/close`,
    'smoke-finance-token', {})).status, 409)
  await db.collection(`${prefix}projects`).insertOne({
    id: 'PRJ-IAM-TRANSFER', title: '异常款项拆分转入项目', source: 'integration-test',
    status: '未满额', statusType: 'primary', progress: 50, remain: 100, deadline: '2099-12-30 12:00',
    total: 100, costAmount: 100, salesAmount: 120, profitAmount: 20,
    companyFixedAmount: 0, companyTakeoverAmount: 0, companyForcedTakeoverAmount: 0,
    employeeSubscribedAmount: 100, subscribed: 100, people: 1, ruleId: 'RULE-IAM-TRANSFER'
  })
  await db.collection(`${prefix}subscription_rules`).insertOne({
    id: 'RULE-IAM-TRANSFER', projectId: 'PRJ-IAM-TRANSFER', ruleName: '异常款项转入规则',
    sharePrice: 100, totalShares: 1, companyFrontShares: 0, totalAmount: 100,
    companyFixedAmount: 0, paymentCutoffAt: '2099-12-31 12:00',
    status: '已启用', updatedAt: new Date().toISOString()
  })
  await db.collection(`${prefix}subscriptions`).insertOne({
    id: 'SUB-IAM-TRANSFER', projectId: 'PRJ-IAM-TRANSFER', project: '异常款项拆分转入项目',
    userId: '1001', amount: 100, shares: 1, pay: '未缴款', profit: 20,
    action: '查看支付', idempotencyKey: 'SUB-IAM-TRANSFER', createdAt: new Date().toISOString(),
    paymentDeadlineAt: '2099-12-31 12:00'
  })
  await db.collection(`${prefix}file_assets`).insertOne({
    id: 'ASSET-IAM-UNATTRIBUTED', provider: 'tencent-cos', bucket: 'test', region: 'test',
    objectKey: 'test/exception-fund-proof/ASSET-IAM-UNATTRIBUTED.png', originalName: 'unattributed.png',
    extension: 'png', mimeType: 'image/png', sizeBytes: 8, sha256: 'd'.repeat(64),
    purpose: 'exception-fund-proof', ownerType: 'project', ownerId: 'exception-staging:1003',
    status: 'ready', createdBy: '1003', createdAt: '2020-01-01 00:00', updatedAt: '2020-01-01 00:00'
  })
  const unattributed = await postAs('/api/exception-funds', 'smoke-finance-token', {
    ...exceptionInput, projectId: undefined, amountCents: 50,
    transactionNo: 'BANK-IAM-UNATTRIBUTED', proofAssetIds: ['ASSET-IAM-UNATTRIBUTED'] })
  assert.equal(unattributed.status, 201, JSON.stringify(unattributed.body))
  const unattributedId = (unattributed.body.data as { id: string }).id
  const assignPath = `/api/exception-funds/${unattributedId}/assign-project`
  assert.equal((await postAs(assignPath, 'smoke-super-admin-token', {
    projectId: 'PRJ-IAM-TRANSFER', reason: '已核对付款人信息与众筹单' })).status, 403)
  assert.equal((await postAs(assignPath, 'smoke-finance-token', {
    projectId: 'PRJ-IAM-TRANSFER', reason: '已核对付款人信息与众筹单' })).status, 200)
  assert.equal((await postAs(assignPath, 'smoke-finance-token', {
    projectId: 'PRJ-IAM-TRANSFER', reason: '重复归属核实请求' })).status, 409)
  assert.equal(await db.collection(`${prefix}fund_ledger`).countDocuments({
    type: 'exception_fund_attributed', projectId: 'PRJ-IAM-TRANSFER' }), 1)
  await db.collection(`${prefix}file_assets`).insertOne({
    id: 'ASSET-IAM-TRANSFER', provider: 'tencent-cos', bucket: 'test', region: 'test',
    objectKey: 'test/exception-fund-proof/ASSET-IAM-TRANSFER.png', originalName: 'transfer.png',
    extension: 'png', mimeType: 'image/png', sizeBytes: 8, sha256: 'c'.repeat(64),
    purpose: 'exception-fund-proof', ownerType: 'project', ownerId: 'exception-staging:1003',
    status: 'ready', createdBy: '1003', createdAt: '2020-01-01 00:00', updatedAt: '2020-01-01 00:00'
  })
  const transferFundCreated = await postAs('/api/exception-funds', 'smoke-finance-token', {
    ...exceptionInput, projectId: 'PRJ-IAM-TRANSFER', amountCents: 10000,
    transactionNo: 'BANK-IAM-TRANSFER', proofAssetIds: ['ASSET-IAM-TRANSFER'] })
  assert.equal(transferFundCreated.status, 201, JSON.stringify(transferFundCreated.body))
  const transferFundId = (transferFundCreated.body.data as { id: string }).id
  const transferPath = `/api/exception-funds/${transferFundId}/transfers`
  const firstTransfer = await postAs(transferPath, 'smoke-finance-token', {
    subscriptionId: 'SUB-IAM-TRANSFER', amountCents: 4000, reason: '异常到账款项转入本人认购单' })
  assert.equal(firstTransfer.status, 201, JSON.stringify(firstTransfer.body))
  assert.equal((await postAs(transferPath, 'smoke-finance-token', {
    subscriptionId: 'SUB-IAM-TRANSFER', amountCents: 7000, reason: '超过剩余可转入金额的请求' })).status, 400)
  const secondTransfer = await postAs(transferPath, 'smoke-finance-token', {
    subscriptionId: 'SUB-IAM-TRANSFER', amountCents: 6000, reason: '剩余款项转入本人认购单' })
  assert.equal(secondTransfer.status, 201, JSON.stringify(secondTransfer.body))
  for (const allocation of [firstTransfer, secondTransfer]) {
    const allocationId = (allocation.body.data as { id: string }).id
    const reviewPath = `/api/exception-funds/${transferFundId}/transfers/${allocationId}/review`
    assert.equal((await postAs(reviewPath, 'smoke-finance-token', { decision: '通过' })).status, 403)
    assert.equal((await postAs(reviewPath, 'smoke-super-admin-token', { decision: '通过' })).status, 200)
    assert.equal((await postAs(reviewPath, 'smoke-super-admin-token', { decision: '通过' })).status, 409)
  }
  const paidTransferSubscription = await db.collection(`${prefix}subscriptions`).findOne({ id: 'SUB-IAM-TRANSFER' })
  assert.equal(paidTransferSubscription?.pay, '已缴款')
  assert.equal(paidTransferSubscription?.actualPaidAmount, 100)
  assert.equal(await db.collection(`${prefix}fund_ledger`).countDocuments({
    subscriptionId: 'SUB-IAM-TRANSFER', type: 'employee_contribution' }), 2)
  const transferFunding = await request('/api/projects/PRJ-IAM-TRANSFER/funding-reconciliation',
    { Authorization: 'Bearer smoke-finance-token' })
  assert.equal(transferFunding.status, 200, JSON.stringify(transferFunding.body))
  assert.equal((transferFunding.body.data as { balanced: boolean }).balanced, true)
  await db.collection(`${prefix}projects`).insertOne({
    id: 'PRJ-IAM-CLOSE', title: '项目关闭退款测试', source: 'integration-test',
    tenantId: '0', ownerUserId: '1002', ownerDeptId: '200',
    status: '未满额', statusType: 'primary', progress: 100, remain: 0, deadline: '2099-12-31 12:00',
    total: 100, costAmount: 100, salesAmount: 120, profitAmount: 20,
    companyFixedAmount: 0, companyTakeoverAmount: 0, companyForcedTakeoverAmount: 0,
    employeeSubscribedAmount: 100, subscribed: 100, people: 1, ruleId: 'RULE-IAM-CLOSE'
  })
  await db.collection(`${prefix}subscription_rules`).insertOne({
    id: 'RULE-IAM-CLOSE', projectId: 'PRJ-IAM-CLOSE', projectName: '项目关闭退款测试',
    tenantId: '0', ownerUserId: '1002', ownerDeptId: '200',
    ruleName: '原关闭项目规则', sharePrice: 100, totalShares: 1, companyFrontShares: 0,
    totalAmount: 100, companyFixedAmount: 0, minAmount: 100, minParticipants: 1,
    allowMultiple: false, companyTakeover: false, status: '已启用',
    startAt: '', endAt: '2099-12-31 12:00', paymentCutoffAt: '2099-12-31 18:00',
    plannedPaymentDate: '2100-01-01', updatedAt: new Date().toISOString()
  })
  await db.collection(`${prefix}subscriptions`).insertOne({
    id: 'SUB-IAM-CLOSE', projectId: 'PRJ-IAM-CLOSE', project: '项目关闭退款测试',
    userId: '1001', amount: 100, shares: 1, pay: '已缴款', profit: 20,
    action: '查看支付', idempotencyKey: 'SUB-IAM-CLOSE', createdAt: new Date().toISOString(),
    paymentDeadlineAt: '2099-12-31 12:00'
  })
  await db.collection(`${prefix}fund_ledger`).insertOne({
    id: 'LED-IAM-CLOSE', sourceKey: 'contribution:SUB-IAM-CLOSE', type: 'employee_contribution',
    projectId: 'PRJ-IAM-CLOSE', subscriptionId: 'SUB-IAM-CLOSE', participantId: '1001', shares: 1,
    amountCents: 10000, transactionNo: 'BANK-IAM-CLOSE-CONTRIBUTION',
    transactionKey: 'BANK-IAM-CLOSE-CONTRIBUTION', proofAssetIds: [], reviewedBy: '1003',
    createdAt: new Date().toISOString()
  })
  const closeProjectPath = '/api/projects/PRJ-IAM-CLOSE/close'
  assert.equal((await postAs(closeProjectPath, 'smoke-employee-token', { reason: '供应商取消订单需要关闭项目' })).status, 403)
  assert.equal((await postAs(closeProjectPath, 'smoke-admin-full-token', { reason: '短' })).status, 400)
  const closingProject = await postAs(closeProjectPath, 'smoke-admin-full-token', { reason: '供应商取消订单需要关闭项目' })
  assert.equal(closingProject.status, 200, JSON.stringify(closingProject.body))
  assert.equal((closingProject.body.data as { status: string }).status, '关闭中')
  assert.equal((await postAs(closeProjectPath, 'smoke-admin-full-token', { reason: '重复发起关闭请求' })).status, 409)
  const refundList = await request('/api/project-refunds?projectId=PRJ-IAM-CLOSE',
    { Authorization: 'Bearer smoke-finance-token' })
  assert.equal(refundList.status, 200)
  assert.equal((refundList.body.data as { total: number }).total, 1)
  const projectRefundId = (refundList.body.data as { items: Array<{ id: string }> }).items[0].id
  await db.collection(`${prefix}file_assets`).insertOne({
    id: 'ASSET-IAM-PROJECT-REFUND', provider: 'tencent-cos', bucket: 'test', region: 'test',
    objectKey: 'test/subscription-refund-proof/ASSET-IAM-PROJECT-REFUND.png', originalName: 'project-refund.png',
    extension: 'png', mimeType: 'image/png', sizeBytes: 8, sha256: 'e'.repeat(64),
    purpose: 'subscription-refund-proof', ownerType: 'subscription', ownerId: 'SUB-IAM-CLOSE',
    status: 'ready', createdBy: '1003', createdAt: '2020-01-01 00:00', updatedAt: '2020-01-01 00:00'
  })
  const projectRefundPaymentPath = `/api/project-refunds/${projectRefundId}/payment`
  const projectRefundInput = { amountCents: 10000, transactionNo: 'BANK-IAM-PROJECT-REFUND',
    paidAt: new Date(Date.now() - 60_000).toISOString(), proofAssetIds: ['ASSET-IAM-PROJECT-REFUND'],
    manualVerificationNote: '已人工核对实际退款流水和收款人' }
  assert.equal((await postAs(projectRefundPaymentPath, 'smoke-finance-token', {
    ...projectRefundInput, amountCents: 9999 })).status, 400)
  assert.equal((await postAs(projectRefundPaymentPath, 'smoke-finance-token', projectRefundInput)).status, 200)
  assert.equal((await postAs(projectRefundPaymentPath, 'smoke-finance-token', projectRefundInput)).status, 409)
  assert.equal(await db.collection(`${prefix}notifications`).countDocuments({
    type: '打款待确认', recipientId: '1001', projectId: 'PRJ-IAM-CLOSE',
    subscriptionId: 'SUB-IAM-CLOSE' }), 1)
  const myProjectRefunds = await request('/api/my-project-refunds', employee)
  assert.equal(myProjectRefunds.status, 200)
  assert.equal((myProjectRefunds.body.data as Array<{ id: string }>).length, 1)
  const projectRefundConfirmPath = `/api/project-refunds/${projectRefundId}/confirm`
  assert.equal((await postAs(projectRefundConfirmPath, 'smoke-finance-token', {})).status, 403)
  assert.equal((await postAs(projectRefundConfirmPath, 'smoke-employee-token', {})).status, 200)
  assert.equal((await postAs(projectRefundConfirmPath, 'smoke-employee-token', {})).status, 409)
  assert.equal((await db.collection(`${prefix}projects`).findOne({ id: 'PRJ-IAM-CLOSE' }))?.status, '已关闭')
  assert.equal(await db.collection(`${prefix}fund_ledger`).countDocuments({
    projectId: 'PRJ-IAM-CLOSE', type: 'subscription_refund_confirmed' }), 1)
  const reopened = await postAs('/api/projects/PRJ-IAM-CLOSE/reopen', 'smoke-admin-full-token', {})
  assert.equal(reopened.status, 201, JSON.stringify(reopened.body))
  const reopenedProject = reopened.body.data as { id: string; status: string; reopenedFromProjectId: string; ruleId: string }
  assert.equal(reopenedProject.status, '未开放')
  assert.equal(reopenedProject.reopenedFromProjectId, 'PRJ-IAM-CLOSE')
  assert.equal((await db.collection(`${prefix}subscription_rules`).findOne({ id: reopenedProject.ruleId }))?.status, '未启用')
  assert.equal((await db.collection(`${prefix}projects`).findOne({ id: 'PRJ-IAM-CLOSE' }))?.reopenedByProjectId,
    reopenedProject.id)
  assert.equal((await postAs('/api/projects/PRJ-IAM-CLOSE/reopen', 'smoke-admin-full-token', {})).status, 409)
  await db.collection(`${prefix}projects`).insertOne({
    id: 'PRJ-IAM-FAIL', title: '采购失败终止测试', source: 'integration-test',
    tenantId: '0', ownerUserId: '1002', ownerDeptId: '200',
    status: '待回款', statusType: 'warning', progress: 100, remain: 0, deadline: '2099-12-31 12:00',
    total: 100, costAmount: 100, salesAmount: 120, profitAmount: 20,
    companyFixedAmount: 30, companyTakeoverAmount: 0, companyForcedTakeoverAmount: 0,
    employeeSubscribedAmount: 70, subscribed: 100, people: 1,
    purchasePaymentId: 'PPAY-IAM-FAIL', purchasePaidAmount: 100
  })
  await db.collection(`${prefix}subscriptions`).insertMany([
    { id: 'SUB-IAM-FAIL', projectId: 'PRJ-IAM-FAIL', project: '采购失败终止测试',
      userId: '1001', amount: 70, shares: 7, pay: '已缴款', profit: 0,
      action: '查看支付', idempotencyKey: 'SUB-IAM-FAIL', createdAt: new Date().toISOString(),
      paymentDeadlineAt: '2099-12-31 12:00' },
    { id: 'SUB-IAM-FAIL-COMPANY', projectId: 'PRJ-IAM-FAIL', project: '采购失败终止测试',
      userId: 'company', companyKind: 'front', amount: 30, shares: 3, pay: '已缴款', profit: 0,
      action: '查看出资', idempotencyKey: 'SUB-IAM-FAIL-COMPANY', createdAt: new Date().toISOString(),
      paymentDeadlineAt: '2099-12-31 12:00' }
  ])
  await db.collection(`${prefix}procurement_payments`).insertOne({ id: 'PPAY-IAM-FAIL', projectId: 'PRJ-IAM-FAIL',
    amountCents: 10000, transactionNo: 'BANK-IAM-FAIL-PROCUREMENT', paidAt: new Date().toISOString(),
    proofAssetIds: [], operatorId: '1003', createdAt: new Date().toISOString() })
  await db.collection(`${prefix}fund_ledger`).insertMany([
    { id: 'LED-IAM-FAIL-EMP', sourceKey: 'contribution:SUB-IAM-FAIL', type: 'employee_contribution',
      projectId: 'PRJ-IAM-FAIL', subscriptionId: 'SUB-IAM-FAIL', participantId: '1001', shares: 7,
      amountCents: 7000, transactionNo: 'BANK-IAM-FAIL-CONTRIBUTION', transactionKey: 'BANK-IAM-FAIL-CONTRIBUTION',
      proofAssetIds: [], reviewedBy: '1003', createdAt: new Date().toISOString() },
    { id: 'LED-IAM-FAIL-COMP', sourceKey: 'company-contribution:SUB-IAM-FAIL-COMPANY', type: 'company_contribution',
      projectId: 'PRJ-IAM-FAIL', subscriptionId: 'SUB-IAM-FAIL-COMPANY', participantId: 'company', shares: 3,
      amountCents: 3000, transactionKey: 'company-contribution:SUB-IAM-FAIL-COMPANY',
      proofAssetIds: [], reviewedBy: '1003', createdAt: new Date().toISOString() },
    { id: 'LED-IAM-FAIL-PAY', sourceKey: 'procurement-payment:PRJ-IAM-FAIL', type: 'procurement_payment',
      projectId: 'PRJ-IAM-FAIL', amountCents: 10000, transactionNo: 'BANK-IAM-FAIL-PROCUREMENT',
      transactionKey: 'bank:BANK-IAM-FAIL-PROCUREMENT', proofAssetIds: [],
      reviewedBy: '1003', createdAt: new Date().toISOString() }
  ])
  await db.collection(`${prefix}receipt_batches`).insertOne({ id: 'RB-IAM-FAIL', kind: '客户回款',
    transactionNo: 'BANK-IAM-FAIL-RECEIPT', bookedAt: new Date().toISOString(),
    totalCents: 2000, lines: [{ projectId: 'PRJ-IAM-FAIL', amountCents: 2000 }],
    proofAssetIds: [], registeredBy: '1003', status: '已通过', reviewedBy: '1008',
    reviewedAt: new Date().toISOString() })
  await db.collection(`${prefix}fund_ledger`).insertOne({ id: 'LED-IAM-FAIL-RECEIPT',
    sourceKey: 'receipt:RB-IAM-FAIL:PRJ-IAM-FAIL', type: 'customer_receipt',
    projectId: 'PRJ-IAM-FAIL', amountCents: 2000, transactionNo: 'BANK-IAM-FAIL-RECEIPT',
    transactionKey: 'receipt:RB-IAM-FAIL:PRJ-IAM-FAIL', proofAssetIds: [],
    reviewedBy: '1008', createdAt: new Date().toISOString() })
  const failPath = '/api/projects/PRJ-IAM-FAIL/procurement-failure'
  assert.equal((await postAs(failPath, 'smoke-finance-token', { reason: '供应商未能完成采购交付' })).status, 403)
  const failRequested = await postAs(failPath, 'smoke-admin-full-token', { reason: '供应商未能完成采购交付' })
  assert.equal(failRequested.status, 201, JSON.stringify(failRequested.body))
  const failRequestId = (failRequested.body.data as { id: string }).id
  assert.equal((await postAs(failPath, 'smoke-admin-full-token', { reason: '重复申请采购失败终止' })).status, 409)
  const reviewFailPath = `/api/procurement-failure-requests/${failRequestId}/review`
  await db.collection(`${prefix}distribution_orders`).insertOne({ id: 'DIST-IAM-FAIL-PENDING',
    projectId: 'PRJ-IAM-FAIL', status: '待审批', lines: [], createdAt: new Date().toISOString() })
  assert.equal((await postAs(reviewFailPath, 'smoke-finance-token', { action: 'approve' })).status, 403)
  await db.collection(`${prefix}subscriptions`).insertOne({ id: 'SUB-IAM-FAIL-PENDING',
    projectId: 'PRJ-IAM-FAIL', project: '采购失败终止测试', userId: '1001', amount: 10,
    pay: '待复核', idempotencyKey: 'SUB-IAM-FAIL-PENDING' })
  assert.equal((await postAs(reviewFailPath, 'smoke-super-admin-token', { action: 'approve' })).status, 409)
  await db.collection(`${prefix}subscriptions`).deleteOne({ id: 'SUB-IAM-FAIL-PENDING' })
  await db.collection(`${prefix}receipt_batches`).insertOne({ id: 'RB-IAM-FAIL-PENDING', kind: '客户回款',
    status: '待复核', lines: [{ projectId: 'PRJ-IAM-FAIL', amountCents: 100 }],
    totalCents: 100, bookedAt: new Date().toISOString() })
  assert.equal((await postAs(reviewFailPath, 'smoke-super-admin-token', { action: 'approve' })).status, 409)
  await db.collection(`${prefix}receipt_batches`).deleteOne({ id: 'RB-IAM-FAIL-PENDING' })
  const failApproved = await postAs(reviewFailPath, 'smoke-super-admin-token', { action: 'approve' })
  assert.equal(failApproved.status, 200, JSON.stringify(failApproved.body))
  assert.equal((await db.collection(`${prefix}projects`).findOne({ id: 'PRJ-IAM-FAIL' }))?.status, '采购失败终止中')
  assert.equal((await db.collection(`${prefix}distribution_orders`).findOne({ id: 'DIST-IAM-FAIL-PENDING' }))?.status, '已作废')
  const failRefund = await db.collection(`${prefix}project_refunds`).findOne({ projectId: 'PRJ-IAM-FAIL' })
  assert.equal(failRefund?.amountCents, 7000)
  assert.equal(failRefund?.reason, '采购失败退款')
  await db.collection(`${prefix}file_assets`).insertMany([
    { id: 'ASSET-IAM-FAIL-SUPPLIER', provider: 'tencent-cos', bucket: 'test', region: 'test',
      objectKey: 'test/supplier-refund-proof/ASSET-IAM-FAIL-SUPPLIER.png', originalName: 'supplier.png',
      extension: 'png', mimeType: 'image/png', sizeBytes: 8, sha256: 'a'.repeat(64),
      purpose: 'supplier-refund-proof', ownerType: 'project', ownerId: 'PRJ-IAM-FAIL',
      status: 'ready', createdBy: '1003', createdAt: '2020-01-01 00:00', updatedAt: '2020-01-01 00:00' },
    { id: 'ASSET-IAM-FAIL-EMPLOYEE', provider: 'tencent-cos', bucket: 'test', region: 'test',
      objectKey: 'test/subscription-refund-proof/ASSET-IAM-FAIL-EMPLOYEE.png', originalName: 'employee.png',
      extension: 'png', mimeType: 'image/png', sizeBytes: 8, sha256: 'b'.repeat(64),
      purpose: 'subscription-refund-proof', ownerType: 'subscription', ownerId: 'SUB-IAM-FAIL',
      status: 'ready', createdBy: '1003', createdAt: '2020-01-01 00:00', updatedAt: '2020-01-01 00:00' },
    { id: 'ASSET-IAM-FAIL-RECEIPT-REFUND', provider: 'tencent-cos', bucket: 'test', region: 'test',
      objectKey: 'test/receipt-termination-refund-proof/ASSET-IAM-FAIL-RECEIPT-REFUND.png',
      originalName: 'receipt-refund.png', extension: 'png', mimeType: 'image/png', sizeBytes: 8,
      sha256: 'c'.repeat(64), purpose: 'receipt-termination-refund-proof', ownerType: 'project',
      ownerId: 'PRJ-IAM-FAIL', status: 'ready', createdBy: '1003',
      createdAt: '2020-01-01 00:00', updatedAt: '2020-01-01 00:00' }
  ])
  const supplierPath = '/api/projects/PRJ-IAM-FAIL/supplier-refunds'
  const supplierInput = { amountCents: 6000, transactionNo: 'BANK-IAM-FAIL-SUPPLIER',
    refundedAt: new Date(Date.now() - 60_000).toISOString(), proofAssetIds: ['ASSET-IAM-FAIL-SUPPLIER'],
    manualVerificationNote: '已核对供应商退款入账流水' }
  assert.equal((await postAs(supplierPath, 'smoke-finance-token', { ...supplierInput, amountCents: 10001 })).status, 400)
  const supplierCreated = await postAs(supplierPath, 'smoke-finance-token', supplierInput)
  assert.equal(supplierCreated.status, 201, JSON.stringify(supplierCreated.body))
  assert.equal((await postAs(supplierPath, 'smoke-finance-token', { ...supplierInput, amountCents: 3000 })).status, 409)
  const finishFailPath = '/api/projects/PRJ-IAM-FAIL/finish-procurement-failure'
  assert.equal((await postAs(finishFailPath, 'smoke-finance-token', { supplierRefundFinalConfirmed: true })).status, 409)
  const failRefundPayment = await postAs(`/api/project-refunds/${failRefund?.id}/payment`, 'smoke-finance-token', {
    amountCents: 7000, transactionNo: 'BANK-IAM-FAIL-EMPLOYEE-REFUND',
    paidAt: new Date(Date.now() - 60_000).toISOString(), proofAssetIds: ['ASSET-IAM-FAIL-EMPLOYEE'],
    manualVerificationNote: '已人工核对员工全额退款流水' })
  assert.equal(failRefundPayment.status, 200, JSON.stringify(failRefundPayment.body))
  const proxyFailPath = `/api/project-refunds/${failRefund?.id}/proxy-confirm`
  assert.equal((await postAs(proxyFailPath, 'smoke-finance-token', {
    reason: '员工超过期限仍未确认实际退款到账' })).status, 400)
  await db.collection(`${prefix}project_refunds`).updateOne({ id: failRefund?.id }, { $set: {
    paidAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString() } })
  const proxyCreated = await postAs(proxyFailPath, 'smoke-finance-token', {
    reason: '员工超过期限仍未确认实际退款到账', accountDisabled: true,
    offlineVerificationNote: '公司线下核对收款账户与原退款流水一致' })
  assert.equal(proxyCreated.status, 201, JSON.stringify(proxyCreated.body))
  const proxyReviewPath = `/api/project-refund-proxy-requests/${(proxyCreated.body.data as { id: string }).id}/review`
  assert.equal((await postAs(proxyReviewPath, 'smoke-finance-token', { action: 'approve' })).status, 403)
  assert.equal((await postAs(proxyReviewPath, 'smoke-super-admin-token', { action: 'approve' })).status, 200)
  assert.equal(await db.collection(`${prefix}notifications`).countDocuments({
    type: '代确认通过', recipientId: '1001', projectId: 'PRJ-IAM-FAIL' }), 1)
  assert.equal((await postAs(proxyReviewPath, 'smoke-super-admin-token', { action: 'approve' })).status, 409)
  assert.equal((await postAs(`/api/project-refunds/${failRefund?.id}/confirm`, 'smoke-employee-token', {})).status, 409)
  assert.equal((await postAs(finishFailPath, 'smoke-finance-token', { supplierRefundFinalConfirmed: true })).status, 409)
  const receiptRefundPath = '/api/projects/PRJ-IAM-FAIL/receipt-termination-refunds'
  const receiptRefundInput = { receiptBatchId: 'RB-IAM-FAIL', amountCents: 2000,
    transactionNo: 'BANK-IAM-FAIL-RECEIPT-REFUND', paidAt: new Date(Date.now() - 60_000).toISOString(),
    proofAssetIds: ['ASSET-IAM-FAIL-RECEIPT-REFUND'], manualVerificationNote: '已核对原客户回款退回银行流水' }
  assert.equal((await postAs(receiptRefundPath, 'smoke-employee-token', receiptRefundInput)).status, 403)
  assert.equal((await postAs(receiptRefundPath, 'smoke-finance-token', {
    ...receiptRefundInput, amountCents: 2001 })).status, 400)
  const receiptRefundCreated = await postAs(receiptRefundPath, 'smoke-finance-token', receiptRefundInput)
  assert.equal(receiptRefundCreated.status, 201, JSON.stringify(receiptRefundCreated.body))
  const receiptRefundId = (receiptRefundCreated.body.data as { id: string }).id
  assert.equal((await postAs(finishFailPath, 'smoke-finance-token', { supplierRefundFinalConfirmed: true })).status, 409)
  const receiptReviewPath = `/api/receipt-termination-refunds/${receiptRefundId}/review`
  assert.equal((await postAs(receiptReviewPath, 'smoke-finance-token', { action: 'approve' })).status, 403)
  assert.equal((await postAs(receiptReviewPath, 'smoke-super-admin-token', { action: 'approve' })).status, 200)
  assert.equal((await postAs(receiptReviewPath, 'smoke-super-admin-token', { action: 'approve' })).status, 409)
  const failFinished = await postAs(finishFailPath, 'smoke-finance-token', { supplierRefundFinalConfirmed: true })
  assert.equal(failFinished.status, 200, JSON.stringify(failFinished.body))
  assert.equal((failFinished.body.data as { companyBackstopCents: number; companyLossCents: number }).companyBackstopCents, 1000)
  assert.equal((failFinished.body.data as { companyLossCents: number }).companyLossCents, 4000)
  assert.equal((await db.collection(`${prefix}projects`).findOne({ id: 'PRJ-IAM-FAIL' }))?.status, '已终止')
  assert.equal((await postAs(finishFailPath, 'smoke-finance-token', { supplierRefundFinalConfirmed: true })).status, 409)
  await db.collection(`${prefix}projects`).insertOne({
    id: 'PRJ-IAM-PAYOUT-PROXY', title: '分配代确认测试', source: 'integration-test',
    status: '分配中', statusType: 'warning', progress: 100, remain: 0, deadline: '2099-12-31 12:00',
    total: 100, costAmount: 100, salesAmount: 120, profitAmount: 20,
    companyFixedAmount: 0, companyTakeoverAmount: 0, companyForcedTakeoverAmount: 0,
    employeeSubscribedAmount: 100, subscribed: 100, people: 1, proxyConfirmDays: 7
  })
  await db.collection(`${prefix}distribution_orders`).insertOne({ id: 'DIST-IAM-PAYOUT-PROXY',
    projectId: 'PRJ-IAM-PAYOUT-PROXY', status: '待员工确认', receivableCents: 12000,
    procurementPaymentCents: 10000, customerReceiptsCents: 12000, companyTopUpsCents: 0,
    companyReturnsCents: 0, confirmedCostsCents: 0, profitCents: 2000,
    companyRoundingResidualCents: 0, payoutTotalCents: 12000, generatedBy: '1003',
    createdAt: new Date().toISOString(), lines: [{ participantId: '1001', kind: 'employee', shares: 1,
      principalCents: 10000, profitCents: 2000, payoutCents: 12000, status: '待员工确认',
      payout: { amountCents: 12000, transactionNo: 'BANK-IAM-PAYOUT-PROXY',
        paidAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
        proofAssetIds: ['ASSET-IAM-PAYOUT-PROXY'], registeredBy: '1003' } }] })
  const payoutProxyPath = '/api/distribution-orders/DIST-IAM-PAYOUT-PROXY/lines/1001/proxy-confirm'
  assert.equal((await postAs(payoutProxyPath, 'smoke-employee-token', {
    reason: '员工超期仍未确认分配款项到账' })).status, 403)
  const payoutProxyCreated = await postAs(payoutProxyPath, 'smoke-finance-token', {
    reason: '员工超期仍未确认分配款项到账' })
  assert.equal(payoutProxyCreated.status, 201, JSON.stringify(payoutProxyCreated.body))
  const payoutProxyReviewPath = `/api/distribution-payout-proxy-requests/${(payoutProxyCreated.body.data as { id: string }).id}/review`
  assert.equal((await postAs(payoutProxyReviewPath, 'smoke-finance-token', { action: 'approve' })).status, 403)
  assert.equal((await postAs(payoutProxyReviewPath, 'smoke-super-admin-token', { action: 'approve' })).status, 200)
  assert.equal(await db.collection(`${prefix}notifications`).countDocuments({
    type: '代确认通过', recipientId: '1001', projectId: 'PRJ-IAM-PAYOUT-PROXY' }), 1)
  assert.equal((await db.collection(`${prefix}distribution_orders`).findOne({ id: 'DIST-IAM-PAYOUT-PROXY' }))?.status, '可结单')
  assert.equal((await postAs(payoutProxyReviewPath, 'smoke-super-admin-token', { action: 'approve' })).status, 409)
  for (const suffix of ['WAIT', 'TOPUP', 'FAIL']) {
    const projectId = `PRJ-IAM-OVERDUE-${suffix}`
    await db.collection(`${prefix}projects`).insertOne({
      id: projectId, title: `回款超期处置 ${suffix}`, source: 'integration-test',
      status: '回款中', statusType: 'warning', progress: 100, remain: 0,
      deadline: '2020-01-01 00:00', total: 100, costAmount: 100, salesAmount: 120,
      profitAmount: 20, companyFixedAmount: 0, companyTakeoverAmount: 0,
      companyForcedTakeoverAmount: 0, employeeSubscribedAmount: 100,
      subscribed: 100, people: 1, purchasePaidAt: '2020-01-02T00:00:00.000Z'
    })
    await db.collection(`${prefix}receipt_overdue_cases`).insertOne({
      id: `ROD-IAM-${suffix}`, projectId, status: '待处置', gapCents: 12000,
      warningCount: 1, lastWarnedAt: new Date().toISOString()
    })
  }
  assert.equal((await request('/api/receipt-overdue-cases', { Authorization: 'Bearer smoke-finance-token' })).status, 403)
  assert.equal((await request('/api/receipt-overdue-cases', { Authorization: 'Bearer smoke-super-admin-token' })).status, 200)
  const waitCasePath = '/api/receipt-overdue-cases/ROD-IAM-WAIT/resolve'
  assert.equal((await postAs(waitCasePath, 'smoke-finance-token', {
    action: '继续等待', note: '客户约定稍后付款', nextWarningDate: '2099-01-01' })).status, 403)
  assert.equal((await postAs(waitCasePath, 'smoke-super-admin-token', {
    action: '继续等待', note: '客户约定稍后付款', nextWarningDate: '2020-01-01' })).status, 400)
  const nextWarningDate = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10)
  assert.equal((await postAs(waitCasePath, 'smoke-super-admin-token', {
    action: '继续等待', note: '客户约定稍后付款', nextWarningDate })).status, 200)
  assert.equal((await db.collection(`${prefix}receipt_overdue_cases`).findOne({ id: 'ROD-IAM-WAIT' }))?.status,
    '等待下次预警')
  assert.equal((await postAs(waitCasePath, 'smoke-super-admin-token', {
    action: '继续等待', note: '重复处置不得成功', nextWarningDate })).status, 409)
  const topupPath = '/api/receipt-overdue-cases/ROD-IAM-TOPUP/resolve'
  assert.equal((await postAs(topupPath, 'smoke-super-admin-token', {
    action: '公司补款', note: '由公司补足客户回款缺口' })).status, 200)
  assert.equal((await db.collection(`${prefix}receipt_overdue_cases`).findOne({ id: 'ROD-IAM-TOPUP' }))?.status,
    '已处置')
  await db.collection(`${prefix}procurement_payments`).insertOne({ id: 'PP-IAM-OVERDUE-FAIL',
    projectId: 'PRJ-IAM-OVERDUE-FAIL', amountCents: 10000, transactionNo: 'BANK-IAM-OVERDUE-FAIL',
    paidAt: '2020-01-02T00:00:00.000Z', proofAssetIds: [], operatorId: '1003' })
  const overdueFailPath = '/api/receipt-overdue-cases/ROD-IAM-FAIL/resolve'
  assert.equal((await postAs(overdueFailPath, 'smoke-super-admin-token', {
    action: '采购失败终止', note: '长期拖欠，采购项目无法继续履约' })).status, 200)
  assert.equal((await db.collection(`${prefix}procurement_failure_requests`).findOne({
    projectId: 'PRJ-IAM-OVERDUE-FAIL' }))?.requestedBy, 'system')
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
