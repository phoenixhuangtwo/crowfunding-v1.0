import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { MongoClient } from 'mongodb'
import { businessCollections, inspectSchema } from '../server/persistence/schema.ts'

async function freePort() {
  const listener = createServer()
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
  const address = listener.address()
  if (!address || typeof address === 'string') throw new Error('cannot allocate test port')
  await new Promise<void>(resolve => listener.close(() => resolve()))
  return address.port
}

const prefix = `__test_share_${randomBytes(6).toString('hex')}_`
const uri = process.env.MONGODB_URI
if (!uri || process.env.MONGODB_DB !== 'crowfunding') throw new Error('run with the local .env.local MongoDB test configuration')
const client = new MongoClient(uri)
await client.connect()
const db = client.db('crowfunding')
const names = [...businessCollections, 'agreement_versions', 'agreement_confirmations'].map(name => `${prefix}${name}`)
const existing = await db.listCollections({ name: { $in: names } }, { nameOnly: true }).toArray()
if (existing.length) throw new Error('isolated test prefix already exists')

let child: ReturnType<typeof spawn> | undefined
try {
  await db.collection(`${prefix}agreement_versions`).insertOne({
    id: 'AGREEMENT-SHARE-TEST', version: 1, title: '隔离测试免责协议',
    body: '员工独立承担税费，分配金额为税前金额；客户退货与坏账不由员工承担，由公司补款；采购失败缺口由公司承担；预估收益不构成承诺。',
    effectiveAt: new Date().toISOString(), createdBy: 'integration-test'
  })
  await db.collection(`${prefix}projects`).insertOne({
    id: 'PRJ-SHARE-TEST', title: '隔离测试采购单', source: 'integration-test',
    status: '未开放', statusType: 'info', progress: 0, remain: 300, deadline: '2099-12-31 23:59',
    total: 300, costAmount: 300, salesAmount: 360, profitAmount: 60,
    companyFixedAmount: 0, companyTakeoverAmount: 0, companyForcedTakeoverAmount: 0,
    employeeSubscribedAmount: 0, subscribed: 0, people: 0
  })
  await db.collection(`${prefix}receiving_codes`).insertOne({
    id: 'RCV-SHARE-TEST', subject: '隔离测试主体', accountNote: 'test', codeName: 'test',
    status: '启用', imageAssetId: 'ASSET-CODE-TEST', updatedBy: 'test', updatedAt: '2099-01-01 00:00'
  })
  await db.collection(`${prefix}projects`).insertOne({
    id: 'PRJ-REVIEW-TEST', title: '隔离测试复核单', source: 'integration-test',
    status: '未满额', statusType: 'primary', progress: 50, remain: 100, deadline: '2099-12-31 23:59',
    total: 200, costAmount: 200, salesAmount: 240, profitAmount: 40,
    companyFixedAmount: 0, companyTakeoverAmount: 0, companyForcedTakeoverAmount: 0,
    employeeSubscribedAmount: 100, subscribed: 100, people: 1
  })
  await db.collection(`${prefix}projects`).insertOne({
    id: 'PRJ-INVOICE-TEST', title: '隔离测试结算单', source: 'integration-test',
    status: '部分已结算', statusType: 'warning', progress: 100, remain: 0, deadline: '2099-12-31 23:59',
    total: 200, costAmount: 200, salesAmount: 240, profitAmount: 40, settledAmount: 100,
    companyFixedAmount: 0, companyTakeoverAmount: 0, companyForcedTakeoverAmount: 0,
    employeeSubscribedAmount: 200, subscribed: 200, people: 2,
    settlementInvoices: [{
      id: 'SETTLED-TEST', assetId: 'ASSET-SETTLED', amount: 100, fileName: 'settled.png',
      transactionDate: '2099-01-01', payer: 'test', payee: 'test', confirmedAt: '2099-01-01 00:00',
      operator: 'finance01 · 财务', resultStatus: '部分已结算', settledAmountAfter: 100, remainingAmountAfter: 140
    }]
  })
  for (const [id, createdBy] of [['ASSET-SETTLED', 'finance01'], ['ASSET-PENDING', 'finance02']]) {
    await db.collection(`${prefix}file_assets`).insertOne({
      id, provider: 'tencent-cos', bucket: 'test', region: 'test', objectKey: `test/${id}`,
      originalName: 'invoice.png', extension: 'png', mimeType: 'image/png', sizeBytes: 8, sha256: 'a'.repeat(64),
      purpose: 'settlement-invoice', ownerType: 'project', ownerId: 'PRJ-INVOICE-TEST',
      status: 'ready', createdBy, createdAt: '2099-01-01 00:00', updatedAt: '2099-01-01 00:00'
    })
  }
  for (const id of ['one', 'two', 'three']) {
    await db.collection(`${prefix}subscriptions`).insertOne({
      id: `SUB-REVIEW-${id}`, projectId: 'PRJ-REVIEW-TEST', project: '隔离测试复核单',
      userId: `employee-${id}`, amount: 100, shares: 1, pay: '待复核', profit: 40,
      action: '查看支付', idempotencyKey: `review-${id}`, createdAt: '2099-01-01 00:00', paymentDeadlineAt: '2099-12-31 23:59',
      paymentImages: [{ id: `PAYIMG-${id}`, assetId: `ASSET-${id}`, paymentImageName: 'proof.png', recognizedAmount: 100, uploadedAt: '2099-01-01 00:01', status: '已识别' }],
      recognizedPaidAmount: 100
    })
    await db.collection(`${prefix}file_assets`).insertOne({
      id: `ASSET-${id}`, provider: 'tencent-cos', bucket: 'test', region: 'test', objectKey: `test/${id}`,
      originalName: 'proof.png', extension: 'png', mimeType: 'image/png', sizeBytes: 1, sha256: 'test',
      purpose: 'payment-proof', ownerType: 'subscription', ownerId: `SUB-REVIEW-${id}`,
      status: 'ready', createdBy: `employee-${id}`, createdAt: '2099-01-01 00:01', updatedAt: '2099-01-01 00:01'
    })
  }
  await db.collection(`${prefix}subscriptions`).insertOne({
    id: 'SUB-RECEIPT-TEST', projectId: 'PRJ-REVIEW-TEST', project: '隔离测试复核单',
    userId: 'employee-receipt', amount: 100, pay: '待确认收款', profit: 40,
    action: '确认收款', idempotencyKey: 'receipt-test', createdAt: '2099-01-01 00:00', paymentDeadlineAt: '2099-12-31 23:59'
  })
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  child = spawn(process.execPath, ['--import', 'tsx', 'server/server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, API_PORT: String(port), NODE_ENV: 'test', PROCUREMENT_SOURCE: 'http', MONGODB_COLLECTION_PREFIX: prefix },
    stdio: 'ignore'
  })
  let ready = false
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) break
    try {
      ready = (await fetch(`${base}/api/health`)).ok
      if (ready) break
    } catch { /* wait for startup */ }
    await delay(100)
  }
  assert.ok(ready, 'isolated API starts')

  async function post(path: string, body: Record<string, unknown>, identity?: { userId: string; role: string }) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (path === '/api/subscriptions') {
      headers['X-User-Id'] = String(body.userId)
      headers['X-User-Role'] = 'employee'
    } else if (/^\/api\/subscriptions\/[^/]+\/review$/.test(path)) {
      headers['X-User-Id'] = 'finance01'
      headers['X-User-Role'] = 'finance'
    } else if (path === '/api/rules' || path.startsWith('/api/rules/') || /^\/api\/projects\/[^/]+\/open$/.test(path)) {
      headers['X-User-Id'] = 'admin01'
      headers['X-User-Role'] = 'admin'
    }
    if (identity) {
      headers['X-User-Id'] = identity.userId
      headers['X-User-Role'] = identity.role
    }
    const requestBody = path === '/api/subscriptions' ? { ...body, agreementVersion: 1 } : body
    const response = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(requestBody) })
    return { status: response.status, payload: await response.json() as { data?: Record<string, unknown>; error?: string } }
  }
  const employeeIdentity = { userId: 'employee-a', role: 'employee' }
  const adminIdentity = { userId: 'admin01', role: 'admin' }
  const codeBody = {
    subject: '隔离测试主体', accountNote: 'test', codeName: 'new-code',
    createRequestId: 'create-code-test', operator: 'spoofed-operator'
  }
  assert.equal((await post('/api/receiving-codes', codeBody, employeeIdentity)).status, 403)
  assert.equal((await post('/api/receiving-codes', codeBody)).status, 401)
  const createdCode = await post('/api/receiving-codes', codeBody, adminIdentity)
  assert.equal(createdCode.status, 201, JSON.stringify(createdCode.payload))
  assert.equal((await db.collection(`${prefix}receiving_codes`).findOne({ createRequestId: codeBody.createRequestId }))?.updatedBy, 'admin01 · 管理员')
  assert.equal((await db.collection(`${prefix}audit_logs`).findOne({ target: createdCode.payload.data?.id }))?.role, 'admin')
  assert.equal((await post(`/api/receiving-codes/${createdCode.payload.data?.id}/disable`, {
    reason: 'test', operator: 'spoofed-operator'
  }, employeeIdentity)).status, 403)
  const disabledCode = await post(`/api/receiving-codes/${createdCode.payload.data?.id}/disable`, {
    reason: 'test', operator: 'spoofed-operator'
  }, adminIdentity)
  assert.equal(disabledCode.status, 200, JSON.stringify(disabledCode.payload))
  assert.equal((await db.collection(`${prefix}receiving_codes`).findOne({ id: createdCode.payload.data?.id }))?.updatedBy, 'admin01 · 管理员')
  assert.equal((await post(`/api/receiving-codes/${createdCode.payload.data?.id}/image`, {
    operator: 'spoofed-operator', imageUrl: 'invalid', imageName: 'invalid.png'
  }, employeeIdentity)).status, 403)
  assert.equal((await post('/api/rules', { projectId: 'PRJ-SHARE-TEST' }, employeeIdentity)).status, 403)
  assert.equal((await post('/api/mcp/sync', {}, employeeIdentity)).status, 403)
  assert.equal((await post('/api/projects/PRJ-SHARE-TEST/open', { ruleId: 'none' }, employeeIdentity)).status, 403)
  assert.equal((await post('/api/projects/PRJ-SHARE-TEST/terminate', {}, { userId: 'finance01', role: 'finance' })).status, 403)
  assert.equal((await post('/api/projects/PRJ-SHARE-TEST/interrupt', { reason: 'forged' }, employeeIdentity)).status, 403)
  assert.equal((await post('/api/takeovers/PRJ-SHARE-TEST/force', {}, adminIdentity)).status, 403)
  assert.equal((await post('/api/takeovers/none/force', {}, { userId: 'super01', role: 'super_admin' })).status, 404)
  assert.equal((await post('/api/settlements/calc', {}, employeeIdentity)).status, 403)
  assert.equal((await post('/api/settlements/calc', {}, { userId: 'finance01', role: 'finance' })).status, 400)
  const profitPreview = await post('/api/settlements/calc', {
    receivableCents: 30301, customerReceiptsCents: 30301, companyTopUpsCents: 0, companyReturnsCents: 0,
    procurementPaymentsCents: 30000, confirmedCostsCents: 0
  }, { userId: 'finance01', role: 'finance' })
  assert.equal(profitPreview.status, 200)
  assert.equal(profitPreview.payload.data?.profitCents, 301)
  assert.equal(profitPreview.payload.data?.previewOnly, true)
  assert.equal((await post('/api/projects/PRJ-SHARE-TEST/settlements/confirm', {
    operator: 'spoofed-operator'
  }, employeeIdentity)).status, 403)
  assert.equal((await post('/api/projects/PRJ-SHARE-TEST/settlements/confirm', {}, {
    userId: 'finance01', role: 'finance'
  })).status, 404)
  const pendingDelete = { projectId: 'PRJ-INVOICE-TEST', assetId: 'ASSET-SETTLED', settlementProofId: 'proof-test' }
  assert.equal((await post('/api/invoices/pending/delete', pendingDelete, employeeIdentity)).status, 403)
  assert.equal((await post('/api/invoices/pending/delete', {
    ...pendingDelete, assetId: 'ASSET-PENDING'
  }, { userId: 'finance01', role: 'finance' })).status, 403)
  const settledDeletion = await post('/api/invoices/pending/delete', pendingDelete, { userId: 'finance01', role: 'finance' })
  assert.equal(settledDeletion.status, 409)
  assert.equal(settledDeletion.payload.error, 'INVOICE_ALREADY_CONFIRMED')
  assert.equal((await db.collection(`${prefix}file_assets`).findOne({ id: 'ASSET-SETTLED' }))?.status, 'ready')
  const invoiceAssetsBefore = await db.collection(`${prefix}file_assets`).countDocuments()
  const invoiceForm = new FormData()
  invoiceForm.set('projectId', 'PRJ-SHARE-TEST')
  invoiceForm.set('image', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), 'invoice.png')
  assert.equal((await fetch(`${base}/api/invoices/ocr`, {
    method: 'POST', headers: { 'X-User-Id': 'employee-a', 'X-User-Role': 'employee' }, body: invoiceForm
  })).status, 403)
  const financeInvoiceForm = new FormData()
  financeInvoiceForm.set('projectId', 'PRJ-SHARE-TEST')
  financeInvoiceForm.set('image', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), 'invoice.png')
  assert.equal((await fetch(`${base}/api/invoices/ocr`, {
    method: 'POST', headers: { 'X-User-Id': 'finance01', 'X-User-Role': 'finance' }, body: financeInvoiceForm
  })).status, 409)
  assert.equal(await db.collection(`${prefix}file_assets`).countDocuments(), invoiceAssetsBefore)
  assert.equal((await db.collection(`${prefix}projects`).findOne({ id: 'PRJ-SHARE-TEST' }))?.status, '未开放')
  const created = await post('/api/rules', {
    projectId: 'PRJ-SHARE-TEST', ruleName: '测试按份规则', receivingCodeId: 'RCV-SHARE-TEST',
    sharePrice: 100, companyFrontShares: 1, maxSharesPerEmployee: 1,
    allowMultiple: true, companyTakeover: true, status: '已启用', endAt: '2099-12-31 23:59',
    paymentCutoffAt: '2100-01-01 12:00', plannedPaymentDate: '2100-01-02', operator: 'spoofed-operator'
  })
  assert.equal(created.status, 201, JSON.stringify(created.payload))
  assert.equal((await db.collection(`${prefix}audit_logs`).findOne({ target: created.payload.data?.id }))?.actor, 'admin01 · 管理员')
  assert.equal(created.payload.data?.totalShares, 3)
  assert.equal((await post(`/api/rules/${created.payload.data?.id}/update`, {}, employeeIdentity)).status, 403)
  const opened = await post('/api/projects/PRJ-SHARE-TEST/open', { ruleId: created.payload.data?.id })
  assert.equal(opened.status, 200, JSON.stringify(opened.payload))
  const beforeSubscriptionCodes = await fetch(`${base}/api/receiving-codes`, {
    headers: { 'X-User-Id': 'employee-a', 'X-User-Role': 'employee' }
  })
  assert.deepEqual((await beforeSubscriptionCodes.json() as { data: unknown[] }).data, [])

  const invalid = await post('/api/subscriptions', {
    projectId: 'PRJ-SHARE-TEST', userId: 'employee-a', shares: 1.5,
    agreementsConfirmed: true, idempotencyKey: 'fractional'
  })
  assert.equal(invalid.status, 400)
  assert.equal(invalid.payload.error, 'SHARE_SUBSCRIPTION_INVALID')

  const accepted = await post('/api/subscriptions', {
    projectId: 'PRJ-SHARE-TEST', userId: 'employee-a', shares: 1,
    agreementsConfirmed: true, idempotencyKey: 'first-share'
  })
  assert.equal(accepted.status, 201, JSON.stringify(accepted.payload))
  assert.equal(accepted.payload.data?.shares, 1)
  assert.equal(accepted.payload.data?.amount, 100)
  assert.equal(accepted.payload.data?.agreementVersion, 1)
  assert.equal(await db.collection(`${prefix}agreement_confirmations`).countDocuments({ node: '提交认购', relatedId: accepted.payload.data?.id, userId: 'employee-a', version: 1 }), 1)
  const receiptHeaders = { 'Content-Type': 'application/json', 'X-User-Id': 'employee-receipt', 'X-User-Role': 'employee' }
  const receiptWithoutAgreement = await fetch(`${base}/api/subscriptions/SUB-RECEIPT-TEST/confirm-receipt`, { method: 'POST', headers: receiptHeaders, body: '{}' })
  assert.equal(receiptWithoutAgreement.status, 409)
  const receiptConfirmed = await fetch(`${base}/api/subscriptions/SUB-RECEIPT-TEST/confirm-receipt`, {
    method: 'POST', headers: receiptHeaders, body: JSON.stringify({ agreementsConfirmed: true, agreementVersion: 1 })
  })
  assert.equal(receiptConfirmed.status, 200)
  assert.equal(await db.collection(`${prefix}agreement_confirmations`).countDocuments({ node: '确认收款', relatedId: 'SUB-RECEIPT-TEST', userId: 'employee-receipt', version: 1 }), 1)
  const codeHeaders = { 'Content-Type': 'application/json', 'X-User-Id': 'employee-a', 'X-User-Role': 'employee' }
  const agreementEmployeeCodes = await fetch(`${base}/api/receiving-codes`, { headers: codeHeaders })
  const codeList = await agreementEmployeeCodes.json() as { data: Array<Record<string, unknown>> }
  assert.equal(codeList.data[0]?.imageAssetId, undefined)
  assert.equal(codeList.data[0]?.imageUrl, undefined)
  const viewedCode = await fetch(`${base}/api/agreements/confirm-view-code`, {
    method: 'POST', headers: codeHeaders, body: JSON.stringify({ subscriptionId: accepted.payload.data?.id, agreementsConfirmed: true, agreementVersion: 1 })
  })
  assert.equal(viewedCode.status, 200)
  assert.equal(await db.collection(`${prefix}agreement_confirmations`).countDocuments({ node: '查看缴款码', relatedId: accepted.payload.data?.id, codeId: 'RCV-SHARE-TEST', userId: 'employee-a' }), 1)

  const forgedSubscription = await fetch(`${base}/api/subscriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Id': 'employee-b', 'X-User-Role': 'employee' },
    body: JSON.stringify({ projectId: 'PRJ-SHARE-TEST', userId: 'employee-a', shares: 1, agreementsConfirmed: true, idempotencyKey: 'forged-share' })
  })
  assert.equal(forgedSubscription.status, 403)
  assert.equal(await db.collection(`${prefix}subscriptions`).countDocuments({ idempotencyKey: 'forged-share' }), 0)
  const otherEmployeeHeaders = { 'X-User-Id': 'employee-b', 'X-User-Role': 'employee' }
  const otherReceipt = await fetch(`${base}/api/subscriptions/${accepted.payload.data?.id}/confirm-receipt`, {
    method: 'POST', headers: { ...otherEmployeeHeaders, 'Content-Type': 'application/json' }, body: '{}'
  })
  assert.equal(otherReceipt.status, 403)
  const otherPayment = new FormData()
  otherPayment.set('subscriptionId', String(accepted.payload.data?.id))
  otherPayment.set('image', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), 'other.png')
  assert.equal((await fetch(`${base}/api/payments/ocr`, {
    method: 'POST', headers: otherEmployeeHeaders, body: otherPayment
  })).status, 403)
  assert.equal((await fetch(`${base}/api/payments/images/delete`, {
    method: 'POST', headers: { ...otherEmployeeHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscriptionId: 'SUB-REVIEW-one', imageId: 'PAYIMG-one' })
  })).status, 403)

  const employeeHeaders = { 'X-User-Id': 'employee-a', 'X-User-Role': 'employee' }
  assert.equal((await fetch(`${base}/api/subscriptions`)).status, 401)
  const employeeSubscriptions = await fetch(`${base}/api/subscriptions`, { headers: employeeHeaders })
  assert.equal(employeeSubscriptions.status, 200)
  assert.deepEqual((await employeeSubscriptions.json() as { data: Array<{ userId: string }> }).data.map(item => item.userId), ['employee-a'])
  const employeeCodes = await fetch(`${base}/api/receiving-codes`, { headers: employeeHeaders })
  assert.deepEqual((await employeeCodes.json() as { data: Array<{ id: string }> }).data.map(item => item.id), ['RCV-SHARE-TEST'])
  assert.equal((await fetch(`${base}/api/state`, { headers: employeeHeaders })).status, 403)
  assert.equal((await fetch(`${base}/api/audit-logs`, { headers: employeeHeaders })).status, 403)

  const assetsBeforeReplacement = await db.collection(`${prefix}file_assets`).countDocuments()
  const replacement = new FormData()
  replacement.set('image', new Blob([Buffer.from('89504e470d0a1a0a', 'hex')], { type: 'image/png' }), 'replacement.png')
  assert.equal((await fetch(`${base}/api/receiving-codes/RCV-SHARE-TEST/image`, {
    method: 'POST', headers: { 'X-User-Id': 'employee-a', 'X-User-Role': 'employee' }, body: replacement
  })).status, 403)
  const codeResponse = await fetch(`${base}/api/receiving-codes/RCV-SHARE-TEST/image`, {
    method: 'POST', headers: { 'X-User-Id': 'finance01', 'X-User-Role': 'finance' }, body: replacement
  })
  assert.equal(codeResponse.status, 409)
  assert.equal((await codeResponse.json() as { error: string }).error, 'RECEIVING_CODE_LOCKED')
  assert.equal(await db.collection(`${prefix}file_assets`).countDocuments(), assetsBeforeReplacement)
  const ruleChange = await post(`/api/rules/${created.payload.data?.id}/update`, { projectId: 'PRJ-SHARE-TEST' })
  assert.equal(ruleChange.status, 409)
  assert.equal(ruleChange.payload.error, 'RULE_LOCKED_BY_SUBSCRIPTION')

  const replay = await post('/api/subscriptions', {
    projectId: 'PRJ-SHARE-TEST', userId: 'employee-a', shares: 1,
    agreementsConfirmed: true, idempotencyKey: 'first-share'
  })
  assert.equal(replay.status, 200)
  assert.equal(replay.payload.data?.id, accepted.payload.data?.id)
  const conflictedReplay = await post('/api/subscriptions', {
    projectId: 'PRJ-SHARE-TEST', userId: 'employee-b', shares: 1,
    agreementsConfirmed: true, idempotencyKey: 'first-share'
  })
  assert.equal(conflictedReplay.status, 409)
  assert.equal(conflictedReplay.payload.error, 'IDEMPOTENCY_KEY_CONFLICT')

  const overLimit = await post('/api/subscriptions', {
    projectId: 'PRJ-SHARE-TEST', userId: 'employee-a', shares: 1,
    agreementsConfirmed: true, idempotencyKey: 'second-share'
  })
  assert.equal(overLimit.status, 400)
  assert.equal(overLimit.payload.error, 'SHARE_SUBSCRIPTION_INVALID')

  const unauthorizedReview = await fetch(`${base}/api/subscriptions/SUB-REVIEW-one/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Id': 'employee-one', 'X-User-Role': 'employee' },
    body: JSON.stringify({ result: 'pass', operator: 'finance01 · 财务', actualPaidAmount: 100, transactionNo: 'BANK-FORGED' })
  })
  assert.equal(unauthorizedReview.status, 403)
  assert.equal((await db.collection(`${prefix}subscriptions`).findOne({ id: 'SUB-REVIEW-one' }))?.pay, '待复核')
  assert.equal(await db.collection(`${prefix}fund_ledger`).countDocuments(), 0)
  assert.equal((await fetch(`${base}/api/subscriptions/SUB-REVIEW-one/review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  })).status, 401)
  const missingBankDetails = await post('/api/subscriptions/SUB-REVIEW-one/review', { result: 'pass', operator: 'spoofed-operator' })
  assert.equal(missingBankDetails.status, 400)
  assert.equal(missingBankDetails.payload.error, 'CONTRIBUTION_REVIEW_MISMATCH')
  const reviewed = await post('/api/subscriptions/SUB-REVIEW-one/review', {
    result: 'pass', operator: 'spoofed-operator', actualPaidAmount: 100, transactionNo: 'BANK-REVIEW-001'
  })
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.payload))
  assert.equal(reviewed.payload.data?.pay, '已缴款')
  assert.equal(reviewed.payload.data?.reviewedBy, 'finance01 · 财务')
  const ledger = await db.collection(`${prefix}fund_ledger`).findOne({ sourceKey: 'contribution:SUB-REVIEW-one' })
  assert.equal(ledger?.amountCents, 10000)
  assert.equal(ledger?.transactionNo, 'BANK-REVIEW-001')
  const duplicateTransaction = await post('/api/subscriptions/SUB-REVIEW-two/review', {
    result: 'pass', operator: 'finance01 · 财务', actualPaidAmount: 100, transactionNo: 'BANK-REVIEW-001'
  })
  assert.equal(duplicateTransaction.status, 409, JSON.stringify(duplicateTransaction.payload))
  assert.equal(duplicateTransaction.payload.error, 'LEDGER_TRANSACTION_DUPLICATE')
  const secondReviewed = await post('/api/subscriptions/SUB-REVIEW-three/review', {
    result: 'pass', operator: 'finance01 · 财务', actualPaidAmount: 100, transactionNo: 'BANK-REVIEW-002'
  })
  assert.equal(secondReviewed.status, 200, JSON.stringify(secondReviewed.payload))
  assert.equal(await db.collection(`${prefix}fund_ledger`).countDocuments({ projectId: 'PRJ-REVIEW-TEST' }), 2)
  const nextAgreement = await post('/api/agreements', {
    title: '隔离测试免责协议第二版',
    body: '员工独立承担税费，分配金额为税前金额；客户退货与坏账不由员工承担，由公司补款；采购失败缺口由公司承担；预估收益不构成承诺。'
  }, { userId: 'superadmin01', role: 'super_admin' })
  assert.equal(nextAgreement.status, 201)
  const staleAgreement = await post('/api/subscriptions', {
    projectId: 'PRJ-SHARE-TEST', userId: 'employee-c', shares: 1,
    agreementsConfirmed: true, idempotencyKey: 'stale-agreement'
  })
  assert.equal(staleAgreement.status, 409)
  assert.equal(staleAgreement.payload.error, 'AGREEMENT_VERSION_CHANGED')
  assert.equal(await db.collection(`${prefix}subscriptions`).countDocuments({ idempotencyKey: 'stale-agreement' }), 0)
  assert.deepEqual(await inspectSchema(db, prefix), [])
  process.stdout.write('按份认购隔离接口测试通过\n')
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await Promise.race([new Promise(resolve => child!.once('exit', resolve)), delay(5000)])
  }
  for (const name of names) {
    const exists = await db.listCollections({ name }, { nameOnly: true }).hasNext()
    if (exists) await db.collection(name).drop()
  }
  await client.close()
}
