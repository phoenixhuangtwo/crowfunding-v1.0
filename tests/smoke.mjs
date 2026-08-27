import { createServer as createHttpServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { spawn } from 'node:child_process'
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')
const statePath = resolve(root, 'data/dev-state.json')
const backupPath = resolve(root, 'data/dev-state.smoke-backup.json')

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function getFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = createNetServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolvePort(port))
    })
  })
}

function startProcurementServer(requests) {
  return new Promise((resolveServer, reject) => {
    const server = createHttpServer((req, res) => {
      requests.push({ url: req.url, authorization: req.headers.authorization })
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        code: 0,
        data: {
          list: [{
            id: 1024,
            sellOrder: 'SMOKE-ORDER-1024',
            projectName: '冒烟测试采购项目',
            totalSellingPrice: 1200000,
            totalTransactionPrice: 1000000,
            totalCostPrice: 800000
          }],
          total: 37,
          totalOut: {},
          totalIn: {}
        },
        msg: ''
      }))
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('failed to start procurement test server'))
      resolveServer({ server, url: `http://127.0.0.1:${address.port}/admin-api/erp/offline-order/page` })
    })
  })
}

function startInvoiceOcrServer(requests) {
  return new Promise((resolveServer, reject) => {
    const server = createHttpServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks).toString('utf8')
      requests.push({ authorization: req.headers.authorization, contentType: req.headers['content-type'], body })
      const requestNumber = requests.length
      const amount = requestNumber === 1 ? 24530.18 : requestNumber === 2 ? 40 : requestNumber === 3 ? 60 : undefined
      const amountText = amount === undefined ? '' : `\n金额（小写）：CNY${amount.toFixed(2)}`
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        content: `交易日期：2026年08月21日\n付款人：冒烟付款公司 付款开户行：测试银行\n收款人：冒烟收款公司 收款方开户行：测试银行${amountText}`,
        prism_version: '1.0.9',
        prism_wnum: 4,
        prism_wordsInfo: [
          { word: '交易日期：2026年08月21日', prob: 99 },
          { word: '付款人：冒烟付款公司 付款开户行：测试银行', prob: 98 },
          { word: '收款人：冒烟收款公司 收款方开户行：测试银行', prob: 99 },
          ...(amount === undefined ? [] : [{ word: `金额（小写）：CNY${amount.toFixed(2)}`, prob: 97 }])
        ]
      }))
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('failed to start invoice OCR test server'))
      resolveServer({ server, url: `http://127.0.0.1:${address.port}/ocrservice/advanced` })
    })
  })
}

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      'content-type': 'application/json',
      ...(options.headers ?? {})
    },
    ...options
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${path} failed: ${response.status} ${JSON.stringify(body)}`)
  }
  return body
}

async function waitForApi(baseUrl, child, logs) {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`API process exited early with code ${child.exitCode}\n${logs.join('')}`)
    }
    try {
      const health = await requestJson(baseUrl, '/api/health')
      if (health.ok === true) return health
    } catch {
      await new Promise(resolveWait => setTimeout(resolveWait, 250))
    }
  }
  throw new Error(`Timed out waiting for API\n${logs.join('')}`)
}

async function stopProcess(child) {
  if (child.exitCode !== null) return
  await new Promise(resolveStop => {
    child.once('exit', resolveStop)
    child.kill('SIGTERM')
    setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL')
    }, 2_000).unref()
  })
}

const originalState = await readFile(statePath, 'utf8')
await copyFile(statePath, backupPath)

const port = await getFreePort()
const baseUrl = `http://127.0.0.1:${port}`
const logs = []
const procurementRequests = []
const procurementUpstream = await startProcurementServer(procurementRequests)
const invoiceOcrRequests = []
const invoiceOcrUpstream = await startInvoiceOcrServer(invoiceOcrRequests)
const child = spawn('npm', ['run', 'api'], {
  cwd: root,
  env: {
    ...process.env,
    API_PORT: String(port),
    PROCUREMENT_API_URL: procurementUpstream.url,
    PROCUREMENT_TOKEN: 'Bearer smoke-test-token',
    INVOICE_OCR_API_URL: invoiceOcrUpstream.url,
    INVOICE_OCR_APPCODE: 'smoke-invoice-code'
  },
  stdio: ['ignore', 'pipe', 'pipe']
})

child.stdout.on('data', chunk => logs.push(chunk.toString()))
child.stderr.on('data', chunk => logs.push(chunk.toString()))

try {
  const health = await waitForApi(baseUrl, child, logs)
  assert(health.service === 'subscription-api', 'health check should expose subscription-api service name')

  const invoiceOcrImageUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
  const invoiceOcrPayload = await requestJson(baseUrl, '/api/invoices/ocr', {
    method: 'POST',
    body: JSON.stringify({ imageDataUrl: invoiceOcrImageUrl, fileName: '发票.png' })
  })
  assert(invoiceOcrPayload.data?.amount === 24530.18, 'invoice OCR route should return the recognized invoice amount')
  assert(JSON.stringify(invoiceOcrPayload.data?.fields) === JSON.stringify([
    { key: 'transactionDate', label: '交易日期', value: '2026年08月21日' },
    { key: 'payer', label: '付款人', value: '冒烟付款公司' },
    { key: 'payee', label: '收款人', value: '冒烟收款公司' },
    { key: 'transactionAmount', label: '交易金额', value: 'CNY 24,530.18' }
  ]), 'invoice OCR route should return the four fixed receipt fields')
  assert(invoiceOcrRequests.length === 1, 'invoice OCR route should call the configured supplier exactly once')
  assert(invoiceOcrRequests[0].authorization === 'APPCODE smoke-invoice-code', 'invoice OCR route should keep AppCode authentication on the server')
  assert(invoiceOcrRequests[0].contentType === 'application/json; charset=UTF-8', 'invoice OCR route should use the advanced OCR JSON content type')
  assert(JSON.parse(invoiceOcrRequests[0].body).img === invoiceOcrImageUrl.split(',')[1], 'invoice OCR route should send the base64 image in the img field without the data URL prefix')

  const statePayload = await requestJson(baseUrl, '/api/state')
  const state = statePayload.data
  assert(Array.isArray(state.projects) && state.projects.length > 0, 'state should include projects')
  assert(Array.isArray(state.subscriptions), 'state should include subscriptions')
  assert(Array.isArray(state.auditLogs), 'state should include audit logs')
  const migratedTargetPayments = state.subscriptions.filter(item => item.projectId === 'PRJ-FSY-OFFLINE-368' && item.paymentImages?.length)
  assert(migratedTargetPayments.length === 3, 'target project should keep its three historical payment records')
  assert(migratedTargetPayments.every(item => item.pay === '待复核'), 'historical unreviewed target payments should migrate to pending review')

  const settlementProject = state.projects.find(project => project.status === '已满额' && project.salesAmount > 0 && !project.settledAmount)
  assert(settlementProject, 'state should include an unsettled full project for settlement confirmation')
  const firstSettlementAmount = Number((settlementProject.salesAmount / 2).toFixed(2))
  const secondSettlementAmount = Number((settlementProject.salesAmount - firstSettlementAmount).toFixed(2))
  const firstSettlement = await requestJson(baseUrl, `/api/projects/${settlementProject.id}/settlements/confirm`, {
    method: 'POST',
    body: JSON.stringify({
      idempotencyKey: 'SMOKE-SETTLEMENT-001',
      amount: firstSettlementAmount,
      fileName: '第一次回单.png',
      imageUrl: invoiceOcrImageUrl,
      transactionDate: '2026年08月21日',
      payer: '冒烟付款方',
      payee: '冒烟收款方',
      operator: 'finance-smoke · 财务'
    })
  })
  assert(firstSettlement.data?.project?.status === '部分已结算', 'first settlement below sales income should mark the project partially settled')
  assert(firstSettlement.data?.canUploadMore === true, 'partial settlement should keep invoice upload available')
  const finalSettlement = await requestJson(baseUrl, `/api/projects/${settlementProject.id}/settlements/confirm`, {
    method: 'POST',
    body: JSON.stringify({
      idempotencyKey: 'SMOKE-SETTLEMENT-002',
      amount: secondSettlementAmount,
      fileName: '第二次回单.png',
      imageUrl: invoiceOcrImageUrl,
      transactionDate: '2026年08月22日',
      payer: '冒烟付款方',
      payee: '冒烟收款方',
      operator: 'finance-smoke · 财务'
    })
  })
  assert(finalSettlement.data?.project?.status === '已完结', 'cumulative settlement equal to sales income should complete the project')
  assert(finalSettlement.data?.remainingAmount === 0 && finalSettlement.data?.canUploadMore === false, 'completed settlement should close further upload')
  const settledProjects = (await requestJson(baseUrl, '/api/projects')).data
  const persistedSettledProject = settledProjects.find(project => project.id === settlementProject.id)
  assert(persistedSettledProject?.status === '已完结' && persistedSettledProject?.settlementInvoices?.length === 2, 'settlement confirmations should persist with the project')
  assert(persistedSettledProject?.settlementInvoices?.[0]?.imageUrl === invoiceOcrImageUrl, 'settlement recognition history should persist the uploaded image')
  assert(persistedSettledProject?.settlementInvoices?.[0]?.resultStatus === '部分已结算', 'partial settlement history should persist its result')
  assert(persistedSettledProject?.settlementInvoices?.[1]?.resultStatus === '已完结', 'final settlement history should persist its completed result')
  const settlementAuditLogs = (await requestJson(baseUrl, '/api/audit-logs')).data
  assert(settlementAuditLogs.some(log => log.target === settlementProject.id && log.action === '确认结算 · 项目完结'), 'completed settlement should write an audit log')

  const rulesPayload = await requestJson(baseUrl, '/api/rules?status=%E5%85%A8%E9%83%A8')
  assert(Array.isArray(rulesPayload.data), 'rules endpoint should return an array')

  const receivingCodesPayload = await requestJson(baseUrl, '/api/receiving-codes')
  const receivingCodeFixture = receivingCodesPayload.data.find(item => item.id === 'RCV-20260701-001')
  assert(receivingCodeFixture, 'receiving code endpoint should expose the seeded rule binding')
  const receivingCodeImageUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
  await requestJson(baseUrl, `/api/receiving-codes/${receivingCodeFixture.id}/image`, {
    method: 'POST',
    body: JSON.stringify({
      imageUrl: receivingCodeImageUrl,
      imageName: 'smoke-receiving-code.png',
      operator: 'finance-smoke · 财务'
    })
  })
  const receivingCodesAfterImage = await requestJson(baseUrl, '/api/receiving-codes')
  const receivingCodeAfterImage = receivingCodesAfterImage.data.find(item => item.id === receivingCodeFixture.id)
  assert(receivingCodeAfterImage?.imageUrl === receivingCodeImageUrl, 'receiving code image should be returned after upload')
  assert(receivingCodeAfterImage?.imageName === 'smoke-receiving-code.png', 'receiving code image should preserve its original filename')

  const invalidReceivingCodeImageResponse = await fetch(`${baseUrl}/api/receiving-codes/${receivingCodeFixture.id}/image`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      imageUrl: 'data:image/svg+xml;base64,PHN2Zy8+',
      imageName: 'unsafe.svg',
      operator: 'finance-smoke · 财务'
    })
  })
  assert(invalidReceivingCodeImageResponse.status === 400, 'receiving code upload should reject unsupported image formats')
  const receivingCodesAfterInvalidImage = await requestJson(baseUrl, '/api/receiving-codes')
  const receivingCodeAfterInvalidImage = receivingCodesAfterInvalidImage.data.find(item => item.id === receivingCodeFixture.id)
  assert(receivingCodeAfterInvalidImage?.imageUrl === receivingCodeImageUrl, 'invalid receiving code image should not overwrite the persisted image')

  const createdReceivingCodePayload = await requestJson(baseUrl, '/api/receiving-codes', {
    method: 'POST',
    body: JSON.stringify({
      subject: '冒烟测试收款主体',
      accountNote: '冒烟测试账户说明',
      codeName: '冒烟测试收款码',
      imageUrl: receivingCodeImageUrl,
      imageName: 'smoke-created-code.png',
      operator: 'finance-smoke · 财务'
    })
  })
  assert(createdReceivingCodePayload.data?.id, 'receiving code creation should return a persistent id')
  await requestJson(baseUrl, `/api/receiving-codes/${createdReceivingCodePayload.data.id}/disable`, {
    method: 'POST',
    body: JSON.stringify({ reason: '冒烟测试禁用', operator: 'finance-smoke · 财务' })
  })
  const receivingCodesAfterDisable = await requestJson(baseUrl, '/api/receiving-codes')
  const disabledReceivingCode = receivingCodesAfterDisable.data.find(item => item.id === createdReceivingCodePayload.data.id)
  assert(disabledReceivingCode?.status === '已禁用', 'created receiving code should remain disabled after reloading the list')
  assert(disabledReceivingCode?.disabledReason === '冒烟测试禁用', 'receiving code disable reason should persist')

  const syncPayload = await requestJson(baseUrl, '/api/mcp/sync', {
    method: 'POST',
    body: JSON.stringify({})
  })
  assert(syncPayload.data?.fetched === 1, 'MCP sync should report the fetched procurement order count')
  assert(syncPayload.data?.total === 37, 'MCP sync should report the upstream procurement order total')
  assert(syncPayload.data?.created === 1, 'MCP sync should create one mapped internal project')
  assert(syncPayload.data?.updated === 0, 'MCP sync should not report an update for a new project')
  assert(syncPayload.data?.skipped === 0, 'MCP sync should not skip a valid new project')
  assert(procurementRequests.length === 1, 'MCP sync should call the procurement API exactly once')
  assert(procurementRequests[0].authorization === 'Bearer smoke-test-token', 'MCP sync should send the server-side procurement token')

  const syncedProjects = await requestJson(baseUrl, '/api/projects')
  const mappedProject = syncedProjects.data.find(item => item.id === 'PRJ-FSY-OFFLINE-1024')
  assert(mappedProject?.title === '冒烟测试采购项目', 'MCP sync should expose the mapped project in the project list')
  assert(mappedProject?.status === '未开放', 'MCP sync should keep newly mapped projects closed')
  assert(mappedProject?.costAmount === 8000, 'MCP sync should convert cost cents to yuan')
  assert(mappedProject?.salesAmount === 10000, 'MCP sync should prefer transaction price and convert cents to yuan')

  const detailPayload = await requestJson(
    baseUrl,
    '/api/procurement/orders/PRJ-FSY-OFFLINE-1024?projectName=%E5%86%92%E7%83%9F%E6%B5%8B%E8%AF%95%E9%87%87%E8%B4%AD%E9%A1%B9%E7%9B%AE'
  )
  assert(detailPayload.data?.id === '1024', 'procurement detail should match the synchronized external order id')
  assert(detailPayload.data?.projectName === '冒烟测试采购项目', 'procurement detail should expose the matched project name')
  assert(detailPayload.data?.totalCostPrice === 8000, 'procurement detail should convert cost cents to yuan')
  assert(detailPayload.data?.totalSellingPrice === 12000, 'procurement detail should convert selling price cents to yuan')
  assert(detailPayload.data?.totalTransactionPrice === 10000, 'procurement detail should convert transaction price cents to yuan')
  assert(procurementRequests.at(-1)?.url?.includes('projectName=%E5%86%92%E7%83%9F%E6%B5%8B%E8%AF%95%E9%87%87%E8%B4%AD%E9%A1%B9%E7%9B%AE'), 'procurement detail should query upstream by project name')

  const secondSyncPayload = await requestJson(baseUrl, '/api/mcp/sync', {
    method: 'POST',
    body: JSON.stringify({})
  })
  assert(secondSyncPayload.data?.created === 0 && secondSyncPayload.data?.updated === 1, 'repeated MCP sync should update the safe existing project without duplicating it')
  const projectsAfterSecondSync = await requestJson(baseUrl, '/api/projects')
  assert(projectsAfterSecondSync.data.filter(item => item.id === 'PRJ-FSY-OFFLINE-1024').length === 1, 'repeated MCP sync should keep exactly one mapped project')

  const ruleFixture = rulesPayload.data.find(item => item.receivingCodeId)
  assert(ruleFixture, 'smoke test needs an existing receiving code binding for rule creation')
  const duplicateRuleBody = {
    projectId: mappedProject.id,
    ruleName: '冒烟测试认购规则',
    companyFixedAmount: 1000,
    minParticipants: 7,
    receivingCodeId: ruleFixture.receivingCodeId,
    allowMultiple: false,
    companyTakeover: true,
    status: '未启用',
    startAt: '2026-08-25 00:00:00',
    endAt: '2026-08-31 00:00:00'
  }
  await requestJson(baseUrl, '/api/rules', {
    method: 'POST',
    body: JSON.stringify(duplicateRuleBody)
  })
  const duplicateRuleResponse = await fetch(`${baseUrl}/api/rules`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...duplicateRuleBody, ruleName: '不应创建的第二条规则' })
  })
  const duplicateRulePayload = await duplicateRuleResponse.json()
  assert(duplicateRuleResponse.status === 409, 'rule creation should reject a project that already has a rule')
  assert(duplicateRulePayload.error === 'PROJECT_RULE_EXISTS', 'duplicate project rule rejection should expose a stable error code')

  const auditPayload = await requestJson(baseUrl, '/api/audit-logs')
  const syncAudit = auditPayload.data.find(item => item.action === '采购订单分页拉取')
  assert(syncAudit?.after?.fetched === 1 && syncAudit?.after?.total === 37, 'MCP sync should audit the returned count summary')

  const project = state.projects.find(item => item.status === '未满额' && Number(item.remain) >= 100)
  assert(project, 'smoke test needs at least one project with status 未满额 and remain >= 100')

  const idempotencyKey = `smoke-${Date.now()}`
  const createBody = {
    projectId: project.id,
    userId: 'smoke-user',
    amount: 100,
    agreementsConfirmed: true,
    idempotencyKey
  }

  const firstCreate = await requestJson(baseUrl, '/api/subscriptions', {
    method: 'POST',
    body: JSON.stringify(createBody)
  })
  const secondCreate = await requestJson(baseUrl, '/api/subscriptions', {
    method: 'POST',
    body: JSON.stringify(createBody)
  })

  assert(firstCreate.data?.id, 'first subscription create should return an id')
  assert(secondCreate.data?.id === firstCreate.data.id, 'same idempotency key should return the same subscription')

  const paymentImageUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
  const firstPaymentOcr = await requestJson(baseUrl, '/api/payments/ocr', {
    method: 'POST',
    body: JSON.stringify({
      paymentId: 'PAY-SMOKE-IMAGE-1',
      subscriptionId: firstCreate.data.id,
      expectedAmount: 100,
      paymentImageUrl,
      paymentImageName: 'smoke-payment-1.png'
    })
  })
  assert(firstPaymentOcr.data?.ocr_amount === 40, 'payment OCR route should use the supplier-recognized amount')

  const subscriptionsAfterFirstPayment = await requestJson(baseUrl, '/api/subscriptions')
  const firstPartialPayment = subscriptionsAfterFirstPayment.data.find(item => item.id === firstCreate.data.id)
  assert(firstPartialPayment?.paymentImages?.length === 1, 'first OCR upload should append one persisted payment screenshot')
  assert(firstPartialPayment?.recognizedPaidAmount === 40, 'first OCR upload should persist the cumulative recognized amount')
  assert(firstPartialPayment?.pay === '部分缴款', 'cumulative amount below the subscription amount should remain partially paid')

  await requestJson(baseUrl, '/api/payments/ocr', {
    method: 'POST',
    body: JSON.stringify({
      paymentId: 'PAY-SMOKE-IMAGE-2',
      subscriptionId: firstCreate.data.id,
      expectedAmount: 100,
      paymentImageUrl,
      paymentImageName: 'smoke-payment-2.png'
    })
  })

  const subscriptionsAfterPayment = await requestJson(baseUrl, '/api/subscriptions')
  const paymentSubscription = subscriptionsAfterPayment.data.find(item => item.id === firstCreate.data.id)
  assert(paymentSubscription?.paymentImages?.length === 2, 'second OCR upload should append instead of overwriting the first screenshot')
  assert(paymentSubscription?.paymentImages?.map(item => item.paymentImageName).join(',') === 'smoke-payment-1.png,smoke-payment-2.png', 'payment screenshot order and names should persist')
  assert(paymentSubscription?.recognizedPaidAmount === 100, 'recognized amounts from multiple screenshots should accumulate')
  assert(paymentSubscription?.pay === '待复核', 'matching the subscription amount should wait for finance review')
  assert(invoiceOcrRequests.length === 3, 'each payment upload should call the configured OCR supplier once')
  assert(invoiceOcrRequests.slice(1).every(item => item.authorization === 'APPCODE smoke-invoice-code'), 'payment OCR should keep AppCode authentication on the server')

  const passedPaymentReview = await requestJson(baseUrl, `/api/subscriptions/${firstCreate.data.id}/review`, {
    method: 'POST',
    body: JSON.stringify({ result: 'pass', operator: 'smoke-finance · 财务' })
  })
  assert(passedPaymentReview.data?.pay === '已缴款', 'passing finance review should finalize the payment')
  assert(passedPaymentReview.data?.reviewedBy === 'smoke-finance · 财务', 'passing finance review should persist the reviewer')
  const repeatedPassedReview = await fetch(`${baseUrl}/api/subscriptions/${firstCreate.data.id}/review`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ result: 'pass', operator: 'smoke-finance · 财务' })
  })
  assert(repeatedPassedReview.status === 409, 'a completed payment review should not be processed twice')

  const reviewCreate = await requestJson(baseUrl, '/api/subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      projectId: project.id,
      userId: 'smoke-review-user',
      amount: 100,
      agreementsConfirmed: true,
      idempotencyKey: `smoke-review-${Date.now()}`
    })
  })
  const reviewPaymentOcr = await requestJson(baseUrl, '/api/payments/ocr', {
    method: 'POST',
    body: JSON.stringify({
      paymentId: 'PAY-SMOKE-REVIEW',
      subscriptionId: reviewCreate.data.id,
      expectedAmount: 100,
      paymentImageUrl,
      paymentImageName: 'smoke-payment-review.png'
    })
  })
  assert(reviewPaymentOcr.data?.ocr_status === '待财务复核', 'missing OCR amount should route the screenshot to finance review')
  const subscriptionsAfterReviewUpload = await requestJson(baseUrl, '/api/subscriptions')
  const reviewSubscription = subscriptionsAfterReviewUpload.data.find(item => item.id === reviewCreate.data.id)
  assert(reviewSubscription?.paymentImages?.length === 1, 'unrecognized payment screenshot should still be persisted')
  assert(reviewSubscription?.paymentImages?.[0]?.status === '识别失败', 'unrecognized payment screenshot should be marked as failed')
  assert(reviewSubscription?.recognizedPaidAmount === 0, 'unrecognized payment screenshot should not increase the cumulative amount')
  assert(reviewSubscription?.pay === '待复核', 'unrecognized payment screenshot should leave the subscription pending finance review')

  const rejectedPaymentReview = await requestJson(baseUrl, `/api/subscriptions/${reviewCreate.data.id}/review`, {
    method: 'POST',
    body: JSON.stringify({
      result: 'reject',
      rejectReason: '支付凭证无法识别，请重新上传',
      operator: 'smoke-finance · 财务'
    })
  })
  assert(rejectedPaymentReview.data?.pay === '复核驳回', 'rejecting finance review should persist the rejected payment state')
  assert(rejectedPaymentReview.data?.rejectReason === '支付凭证无法识别，请重新上传', 'rejecting finance review should persist the rejection reason')

  const failedPaymentImageId = reviewSubscription?.paymentImages?.[0]?.id
  assert(failedPaymentImageId, 'failed payment screenshot should expose a persisted image id for deletion')
  await requestJson(baseUrl, '/api/payments/images/delete', {
    method: 'POST',
    body: JSON.stringify({
      subscriptionId: reviewCreate.data.id,
      imageId: failedPaymentImageId
    })
  })
  const subscriptionsAfterFailedImageDeletion = await requestJson(baseUrl, '/api/subscriptions')
  const reviewSubscriptionAfterDeletion = subscriptionsAfterFailedImageDeletion.data.find(item => item.id === reviewCreate.data.id)
  assert(reviewSubscriptionAfterDeletion?.paymentImages?.length === 0, 'deleting a failed screenshot should remove it from persisted payment images')
  assert(reviewSubscriptionAfterDeletion?.recognizedPaidAmount === 0, 'deleting a failed screenshot should keep the cumulative recognized amount unchanged')
  assert(reviewSubscriptionAfterDeletion?.pay === '未缴款', 'deleting the only failed screenshot should restore the unpaid state')

  const recognizedPaymentImageId = paymentSubscription?.paymentImages?.[0]?.id
  const recognizedImageDeleteResponse = await fetch(`${baseUrl}/api/payments/images/delete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      subscriptionId: firstCreate.data.id,
      imageId: recognizedPaymentImageId
    })
  })
  assert(recognizedImageDeleteResponse.status === 409, 'deleting a recognized payment screenshot should be rejected')
  const subscriptionsAfterRejectedDeletion = await requestJson(baseUrl, '/api/subscriptions')
  const paymentAfterRejectedDeletion = subscriptionsAfterRejectedDeletion.data.find(item => item.id === firstCreate.data.id)
  assert(paymentAfterRejectedDeletion?.paymentImages?.length === 2, 'rejected deletion should preserve recognized payment screenshots')

  const invalidPaymentImageResponse = await fetch(`${baseUrl}/api/payments/ocr`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      state: 'ok',
      paymentId: 'PAY-SMOKE-INVALID-IMAGE',
      subscriptionId: firstCreate.data.id,
      expectedAmount: 100,
      paymentImageUrl: 'data:image/svg+xml;base64,PHN2Zy8+',
      paymentImageName: 'unsafe.svg'
    })
  })
  assert(invalidPaymentImageResponse.status === 400, 'OCR upload should reject unsupported payment screenshot formats')

  const subscriptionsAfterInvalidPayment = await requestJson(baseUrl, '/api/subscriptions')
  const paymentAfterInvalidUpload = subscriptionsAfterInvalidPayment.data.find(item => item.id === firstCreate.data.id)
  assert(paymentAfterInvalidUpload?.paymentImages?.length === 2, 'invalid screenshot upload should not append or overwrite persisted payment images')

  const persistedState = JSON.parse(await readFile(statePath, 'utf8'))
  const persistedReceivingCode = persistedState.receivingCodes.find(item => item.id === receivingCodeFixture.id)
  assert(persistedReceivingCode?.imageUrl === receivingCodeImageUrl, 'receiving code image should persist in local state')
  assert(persistedReceivingCode?.imageName === 'smoke-receiving-code.png', 'receiving code image filename should persist in local state')
  const persistedPayment = persistedState.subscriptions.find(item => item.id === firstCreate.data.id)
  assert(persistedPayment?.paymentImages?.length === 2, 'OCR upload should persist every payment screenshot in local state')
  assert(persistedPayment?.recognizedPaidAmount === 100, 'OCR upload should persist the cumulative recognized amount in local state')

  const afterPayload = await requestJson(baseUrl, '/api/state')
  const matches = afterPayload.data.subscriptions.filter(item => item.idempotencyKey === idempotencyKey)
  assert(matches.length === 1, 'same idempotency key should create exactly one subscription')

  console.log(JSON.stringify({
    ok: true,
    api: baseUrl,
    checked: ['health', 'invoice OCR proxy', 'state', 'partial and completed settlement persistence', 'settlement audit', 'rules', 'receiving code image persistence', 'duplicate project rule guard', 'procurement detail', 'subscription idempotency', 'multiple payment screenshot accumulation', 'state restore guard']
  }, null, 2))
} finally {
  await stopProcess(child)
  await new Promise(resolveClose => procurementUpstream.server.close(resolveClose))
  await new Promise(resolveClose => invoiceOcrUpstream.server.close(resolveClose))
  await writeFile(statePath, originalState)
  await copyFile(backupPath, statePath)
  await rm(backupPath, { force: true })
}
