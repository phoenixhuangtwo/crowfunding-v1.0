import { observeRequests, logFailure, currentRequestId } from './observability.ts'
import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { fetchAllProcurementPages, fetchProcurementPage, formatProcurementSyncMessage } from './procurement.ts'
import { mapProcurementOrderToDetail, mapProcurementOrderToProject, mergeProcurementProject, procurementOrderSkipReason } from './procurement-project.ts'
import { recognizeFinanceBill } from './invoice-ocr.ts'
import { confirmProjectSettlement, type SettlementInvoiceRecord } from './project-settlement.ts'
import { DEFAULT_JSON_BODY_LIMIT, bodyContainsAccessToken, readJsonBody, readRawBody, RequestBodyError } from './http-json-body.ts'
import { OcrProofStore } from './ocr-proof.ts'
import { hasImageStorageCapacity, ResourceLimitError, SlidingWindowQuota } from './resource-limits.ts'
import { loadAppConfig } from './config.ts'
import { connectMongo } from './persistence/mongo.ts'
import { createRepositories } from './persistence/repositories.ts'
import { ensureSchema } from './persistence/schema.ts'
import { QueryService, presentReceivingCode } from './services/query-service.ts'
import { createReceivingCodeOnce } from './services/receiving-code-creation.ts'
import { readSingleImageMultipart } from './http-multipart.ts'
import { validateImageFile, type ValidatedImage } from './image-file.ts'
import { TencentCosObjectStorage } from './storage/object-storage.ts'
import { FileAssetService } from './storage/file-asset-service.ts'
import { requestContext, authorizeAssetRead, setAuthenticatedContext, iamContextFor } from './request-context.ts'
import { AppError, isDuplicateKey } from './errors.ts'
import { calculateShareSubscription, prepareShareRule } from './share-subscription.ts'
import { createFundLedger } from './finance/fund-ledger.ts'
import { validateContributionReview } from './finance/contribution-review.ts'
import { reconcileProcurementFunding, validateProcurementPayment } from './finance/procurement-payment.ts'
import { calculateSettlementProfit } from './finance/settlement-profit.ts'
import { makeDistributionOrder, distributionOrderIsActive, deriveDistributionStatus, type DistributionOrder } from './finance/distribution-orders.ts'
import { validateCostRegistration, type ConfirmedCost } from './finance/confirmed-costs.ts'
import { reconcileProjectFinancials } from './finance/financial-reconciliation.ts'
import { validateProjectRefundPayment, type ProjectRefund } from './finance/project-refunds.ts'
import { confirmExceptionRefund, reserveExceptionRefund, reserveExceptionTransfer, reviewExceptionTransfer,
  validateExceptionFund, type ExceptionFund } from './finance/exception-funds.ts'
import { reviewReceiptBatch, summarizeProjectReceipts, validateReceiptRegistration, type ReceiptBatch } from './finance/customer-receipts.ts'
import { unresolvedReceiptDifference, validateReceiptDifference, type ReceiptDifference } from './finance/receipt-differences.ts'
import { planCompanyBackstop, paymentCutoffTime } from './company-backstop.ts'
import { AgreementError, AgreementService, type AgreementNode } from './agreements.ts'
import { loadIamConfig } from './iam/config.ts'
import { IamClient } from './iam/client.ts'
import { handleAuthRoute } from './auth/routes.ts'
import { authenticateRequest, authErrorResponse, permissionInfoForClient, requireApiPermission, validateReviewAction } from './auth/middleware.ts'
import { handleCorsPreflight, sendJson } from './http-response.ts'
import { ownershipFrom } from './iam/data-scope.ts'
import { employeePaymentDeadline, validatePublishSchedule } from './publish-schedule.ts'

type Role = 'employee' | 'admin' | 'finance' | 'super_admin' | 'system'
type ProjectStatus = '未开放' | '未满额' | '已满额' | '已截止' | '待回款' | '回款中' | '待分配' | '分配中' | '已中断' | '关闭中' | '已关闭' | '部分已结算' | '已完结'
type PaymentStatus = '未缴款' | '部分缴款' | '已缴款' | '待复核' | '复核驳回' | '已收款' | '已释放' | '公司待出资' | '待退款' | '待确认退款' | '已退款'

type PaymentImage = {
  id: string
  assetId: string
  paymentImageUrl?: string
  paymentImageName: string
  recognizedAmount: number
  uploadedAt: string
  status: '已识别' | '识别失败'
}

type Project = {
  id: string
  title: string
  source: string
  offlineSalesOrder?: string
  createdAt?: string
  projectOwner?: string
  tenantId?: string
  ownerUserId?: string
  ownerDeptId?: string
  reopenedFromProjectId?: string
  reopenedByProjectId?: string
  status: ProjectStatus
  statusType: 'primary' | 'success' | 'warning' | 'danger' | 'info'
  progress: number
  remain: number
  deadline: string
  total: number
  costAmount: number
  salesAmount: number
  profitAmount: number
  companyFixedAmount: number
  companyTakeoverAmount: number
  companyBackstopShares?: number
  companyForcedTakeoverAmount: number
  employeeSubscribedAmount: number
  subscribed: number
  people: number
  interruptReason?: string
  interruptedAt?: string
  refundNotice?: string
  ruleId?: string
  settledAmount?: number
  purchasePaymentId?: string
  purchasePaidAt?: string
  purchasePaidAmount?: number
  closedAt?: string
  closedBy?: string
  settlementInvoices?: SettlementInvoiceRecord[]
}

type Subscription = {
  id: string
  projectId: string
  project: string
  userId: string
  userName?: string
  amount: number
  shares?: number
  companyKind?: 'front' | 'backstop'
  pay: PaymentStatus | '待确认收款'
  profit: number
  action: string
  idempotencyKey: string
  createdAt: string
  paymentDeadlineAt: string
  paymentUploadedAt?: string
  paymentSuccessAt?: string
  paymentImageUrl?: string
  paymentImageName?: string
  paymentImages?: PaymentImage[]
  recognizedPaidAmount?: number
  actualPaidAmount?: number
  transactionNo?: string
  reviewedBy?: string
  reviewedAt?: string
  rejectReason?: string
  agreementVersion?: number
  receiptAgreementVersion?: number
}

type AuditLog = {
  time: string
  actor: string
  role: Role
  action: string
  target: string
  before: unknown
  after: unknown
  result: '成功' | '失败'
}

type RiskEvent = {
  time: string
  level: string
  desc: string
  status: string
}

type SubscriptionRule = {
  id: string
  projectId: string
  projectName: string
  tenantId?: string
  ownerUserId?: string
  ownerDeptId?: string
  ruleName: string
  totalAmount: number
  sharePrice?: number
  totalShares?: number
  companyFrontShares?: number
  maxSharesPerEmployee?: number
  companyFixedAmount: number
  minAmount: number
  minParticipants: number
  receivingCodeId?: string
  allowMultiple: boolean
  companyTakeover: boolean
  status: '未启用' | '已启用' | '已停用'
  startAt: string
  endAt: string
  paymentCutoffAt?: string
  plannedPaymentDate?: string
  updatedAt: string
}

type ReceivingCode = {
  id: string
  subject: string
  accountNote: string
  codeName: string
  status: '启用' | '已禁用'
  updatedBy: string
  updatedAt: string
  disabledReason?: string
  imageUrl?: string
  imageName?: string
  imageAssetId?: string
}

type AppState = {
  projects: Project[]
  subscriptions: Subscription[]
  auditLogs: AuditLog[]
  riskEvents: RiskEvent[]
  rules: SubscriptionRule[]
  receivingCodes: ReceivingCode[]
}

type ProcurementPayment = {
  id: string
  projectId: string
  amountCents: number
  transactionNo: string
  paidAt: string
  proofAssetIds: string[]
  operatorId: string
  companyFundsConfirmed: true
  recognitionStatus: '凭证识别未通过' | '凭证已核对'
  note: string
  createdAt: string
}

function normalizeProjectAmounts(project: Project) {
  const employeeSubscribedAmount = Number(project.employeeSubscribedAmount)
  const normalizedEmployee = Number.isFinite(employeeSubscribedAmount)
    ? Math.max(0, employeeSubscribedAmount)
    : Math.max(0, Number(project.subscribed) || 0)
  const companyTakeoverAmount = Number(project.companyTakeoverAmount)
  const normalizedTakeover = Number.isFinite(companyTakeoverAmount) ? Math.max(0, companyTakeoverAmount) : 0
  const companyForcedTakeoverAmount = Number(project.companyForcedTakeoverAmount)
  const normalizedForcedTakeover = Number.isFinite(companyForcedTakeoverAmount) ? Math.max(0, companyForcedTakeoverAmount) : 0
  const remainAmount = Number(project.remain)
  const legacyRemain = Number.isFinite(remainAmount) ? Math.max(0, remainAmount) : Math.max(0, project.costAmount - normalizedEmployee - normalizedTakeover - normalizedForcedTakeover)
  const companyFixedAmount = Number(project.companyFixedAmount)
  const normalizedFixed = Number.isFinite(companyFixedAmount)
    ? Math.max(0, companyFixedAmount)
    : Math.max(0, project.costAmount - legacyRemain - normalizedEmployee - normalizedTakeover - normalizedForcedTakeover)
  const recognizedAmount = Math.min(project.costAmount, normalizedFixed + normalizedTakeover + normalizedForcedTakeover + normalizedEmployee)
  project.companyFixedAmount = normalizedFixed
  project.companyTakeoverAmount = normalizedTakeover
  project.companyForcedTakeoverAmount = normalizedForcedTakeover
  project.employeeSubscribedAmount = normalizedEmployee
  project.subscribed = recognizedAmount
  project.remain = Math.max(0, project.costAmount - recognizedAmount)
  project.progress = project.costAmount > 0 ? Number(((recognizedAmount / project.costAmount) * 100).toFixed(1)) : 0
}

function normalizeRuleStatus(status: unknown): SubscriptionRule['status'] {
  if (status === '已发布') return '已启用'
  if (status === '草稿') return '未启用'
  if (status === '已启用' || status === '未启用' || status === '已停用') return status
  return '未启用'
}

function isCompanySubscription(subscription: Subscription) {
  return ['company', 'company01', 'superadmin01'].includes(subscription.userId)
}

function hasRealUserSubscriptions(projectId: string) {
  return subscriptions.some(item => item.projectId === projectId && !isCompanySubscription(item))
}

function isOwnedByAdmin(req: IncomingMessage, item: { tenantId?: string; ownerUserId?: string }) {
  const identity = iamContextFor(req)
  return item.tenantId === identity.tenantId && item.ownerUserId === identity.userId
}

function requireAdminOwned(req: IncomingMessage, item: { tenantId?: string; ownerUserId?: string }) {
  if (requestContext(req).role === 'admin' && !isOwnedByAdmin(req, item)) {
    throw new AppError(404, 'SCOPE_DENIED', '资源不存在或无权访问')
  }
}

function requireAdminDraftProject(req: IncomingMessage, projectId: unknown) {
  if (requestContext(req).role !== 'admin') return
  const project = projects.find(item => item.id === projectId)
  if (!project || project.status !== '未开放') throw new AppError(404, 'SCOPE_DENIED', '资源不存在或无权访问')
}

function getRuleProjectIds(ruleId: string) {
  const rule = rules.find(item => item.id === ruleId)
  return projects
    .filter(project => project.ruleId === ruleId || project.id === rule?.projectId)
    .map(project => project.id)
}

function isRuleLocked(ruleId: string) {
  return getRuleProjectIds(ruleId).some(projectId => subscriptions.some(item => item.projectId === projectId))
}

async function receivingCodeHasSubscriptions(receivingCodeId: string, session?: import('mongodb').ClientSession) {
  const linkedRules = await repositories.rules.list({ receivingCodeId } as never, {}, session)
  const projectIds = linkedRules.map(rule => rule.projectId)
  if (projectIds.length === 0) return false
  return (await repositories.subscriptions.count({ projectId: { $in: projectIds } } as never, session)) > 0
}

async function requireReceivingCodeMutable(receivingCodeId: string, session?: import('mongodb').ClientSession) {
  if (await receivingCodeHasSubscriptions(receivingCodeId, session)) {
    throw new AppError(409, 'RECEIVING_CODE_LOCKED', '已有认购单的众筹项目不可更换或补传收款码图片')
  }
}

const appConfig = loadAppConfig()
const iamConfig = loadIamConfig()
if (iamConfig.multiTenantEnabled) throw new Error('存量业务记录尚无租户归属，不能启用 IAM 多租户模式')
const iam = new IamClient(iamConfig)
const mongo = await connectMongo(appConfig.mongodb)
await ensureSchema(mongo.db, appConfig.mongodb.collectionPrefix)
const repositories = createRepositories(mongo.db, appConfig.mongodb.collectionPrefix)
const fundLedger = createFundLedger(mongo.db, appConfig.mongodb.collectionPrefix)
const procurementPayments = mongo.db.collection<ProcurementPayment>(`${appConfig.mongodb.collectionPrefix}procurement_payments`)
const receiptBatches = mongo.db.collection<ReceiptBatch>(`${appConfig.mongodb.collectionPrefix}receipt_batches`)
const receiptDifferences = mongo.db.collection<ReceiptDifference>(`${appConfig.mongodb.collectionPrefix}receipt_differences`)
const distributionOrders = mongo.db.collection<DistributionOrder>(`${appConfig.mongodb.collectionPrefix}distribution_orders`)
const confirmedCosts = mongo.db.collection<ConfirmedCost>(`${appConfig.mongodb.collectionPrefix}confirmed_costs`)
const exceptionFunds = mongo.db.collection<ExceptionFund>(`${appConfig.mongodb.collectionPrefix}exception_funds`)
const projectRefunds = mongo.db.collection<ProjectRefund>(`${appConfig.mongodb.collectionPrefix}project_refunds`)
const bankTransactions = mongo.db.collection<{ transactionNo: string; sourceKey: string; projectId: string; createdAt: string }>(`${appConfig.mongodb.collectionPrefix}bank_transactions`)
const agreementService = new AgreementService(mongo.db, appConfig.mongodb.collectionPrefix)
await agreementService.ensureIndexes()
const queryService = new QueryService(repositories)
const objectStorage = new TencentCosObjectStorage(appConfig.cos)
const fileAssetService = new FileAssetService({
  assets: repositories.fileAssets,
  storage: objectStorage,
  mongo,
  config: appConfig.cos
})
const state: AppState = {
  projects: await repositories.projects.list() as Project[],
  subscriptions: await repositories.subscriptions.list() as Subscription[],
  auditLogs: await repositories.auditLogs.list() as AuditLog[],
  riskEvents: await repositories.riskEvents.list() as RiskEvent[],
  rules: await repositories.rules.list() as SubscriptionRule[],
  receivingCodes: await repositories.receivingCodes.list() as ReceivingCode[]
}
const { projects, subscriptions, auditLogs, riskEvents, rules, receivingCodes } = state

const maxImageDataUrlLength = Math.ceil(5 * 1024 * 1024 * 4 / 3) + 128
const maxStoredImageDataUrlChars = 100 * 1024 * 1024
const maxPaymentImagesPerSubscription = 10
const maxSettlementInvoicesPerProject = 20
const maxReceivingCodes = 100
const supportedImageDataUrl = /^data:image\/(?:png|jpeg|bmp|webp);base64,[A-Za-z0-9+/]+={0,2}$/
const supportedPaymentImageDataUrl = /^data:image\/(?:png|jpeg|bmp);base64,[A-Za-z0-9+/]+={0,2}$/
const ocrProofStore = new OcrProofStore()
const ocrQuota = new SlidingWindowQuota({ limit: 30, windowMs: 60_000 })

function storedImageDataUrlChars() {
  return receivingCodes.reduce((sum, item) => sum + (item.imageUrl?.length ?? 0), 0)
    + subscriptions.reduce((sum, item) => sum
      + (item.paymentImageUrl?.length ?? 0)
      + (item.paymentImages ?? []).reduce((imageSum, image) => imageSum + (image.paymentImageUrl?.length ?? 0), 0), 0)
    + projects.reduce((sum, item) => sum + (item.settlementInvoices ?? []).reduce((imageSum, invoice) => imageSum + (invoice.imageUrl?.length ?? 0), 0), 0)
}

function ensureImageStorageCapacity(res: ServerResponse, incomingImageUrl: string, replacedImageUrl = '', incomingCopies = 1) {
  if (hasImageStorageCapacity(storedImageDataUrlChars(), replacedImageUrl.length, incomingImageUrl.length * incomingCopies, maxStoredImageDataUrlChars)) return true
  send(res, 429, { error: 'IMAGE_STORAGE_LIMIT_EXCEEDED', message: '本地图片存储已达上限，请先清理历史图片' })
  return false
}

function validateImagePayload(body: Record<string, unknown>, res: ServerResponse, errorPrefix: string) {
  const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : ''
  const imageName = typeof body.imageName === 'string' ? body.imageName.trim() : ''
  if (!imageUrl || !supportedImageDataUrl.test(imageUrl) || imageUrl.length > maxImageDataUrlLength) {
    send(res, 400, { error: `${errorPrefix}_IMAGE_INVALID`, message: '图片仅支持 PNG、JPG 或 WebP 格式，且大小不能超过 5MB' })
    return null
  }
  if (!imageName || imageName.length > 255) {
    send(res, 400, { error: `${errorPrefix}_IMAGE_NAME_INVALID`, message: '图片文件名无效' })
    return null
  }
  return { imageUrl, imageName }
}

async function persistRepository<T extends { id: string }>(
  repository: {
    sync(documents: T[], session?: import('mongodb').ClientSession): Promise<void>
  },
  documents: T[],
  session: import('mongodb').ClientSession
) {
  await repository.sync(documents, session)
}

async function persistState() {
  await mongo.withTransaction(async session => {
    await persistRepository(repositories.projects, projects as never[], session)
    await persistRepository(repositories.subscriptions, subscriptions as never[], session)
    await persistRepository(repositories.auditLogs, auditLogs as never[], session)
    await persistRepository(repositories.riskEvents, riskEvents as never[], session)
    await persistRepository(repositories.rules, rules as never[], session)
    await persistRepository(repositories.receivingCodes, receivingCodes as never[], session)
    return true
  })
}

function formatDateTime(date = new Date()) {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function parseDateTime(datetime?: string) {
  if (!datetime || datetime === 'Invalid Date') return new Date()
  const date = new Date(datetime.replace(' ', 'T'))
  return Number.isNaN(date.getTime()) ? new Date() : date
}

function now() {
  return formatDateTime()
}

async function procurementFundingSnapshot(projectId: string, session?: import('mongodb').ClientSession) {
  const project = await repositories.projects.getById(projectId, session)
  if (!project) throw new AppError(404, 'PROJECT_NOT_FOUND', '项目不存在')
  const rule = project.ruleId ? await repositories.rules.getById(project.ruleId, session) : null
  if (!rule?.sharePrice) throw new AppError(409, 'SHARE_RULE_REQUIRED', '该项目尚无 V1.1 按份认购规则')
  const [records, ledger] = await Promise.all([
    repositories.subscriptions.list({ projectId }, {}, session), fundLedger.listProjectContributions(projectId, session)
  ])
  const employeeRecords = new Map(records.filter(record => record.userId !== 'company').map(record => [record.id, record]))
  const contributionTotals = new Map<string, number>()
  for (const entry of ledger) {
    const record = employeeRecords.get(entry.subscriptionId)
    if (!record || !['已缴款', '部分缴款'].includes(record.pay)
      || !Number.isSafeInteger(entry.amountCents) || entry.amountCents <= 0) {
      throw new AppError(409, 'FUNDING_LEDGER_INCONSISTENT', '已生效缴款与资金台账不一致，请先核对')
    }
    contributionTotals.set(entry.subscriptionId, (contributionTotals.get(entry.subscriptionId) ?? 0) + entry.amountCents)
  }
  if ([...employeeRecords.values()].some(record => {
    const total = contributionTotals.get(record.id) ?? 0
    const expected = Math.round(record.amount * 100)
    return record.pay === '已缴款' ? total !== expected
      : record.pay === '部分缴款' ? total > expected : total !== 0
  })) {
    throw new AppError(409, 'FUNDING_LEDGER_INCONSISTENT', '已生效缴款与资金台账不一致，请先核对')
  }
  const cents = (value: number, name: string) => {
    const amount = Math.round(value * 100)
    if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(amount) || Math.abs(value * 100 - amount) > 0.000001) {
      throw new AppError(409, 'FUNDING_AMOUNT_INVALID', `${name}金额无效，请先核对`)
    }
    return amount
  }
  const fundingInput = {
    purchaseCents: cents(project.costAmount, '采购'),
    approvedEmployeeCents: ledger.filter(entry => employeeRecords.get(entry.subscriptionId)?.pay === '已缴款')
      .reduce((sum, entry) => sum + entry.amountCents, 0),
    companyFrontCents: records.filter(record => record.companyKind === 'front').reduce((sum, record) => sum + cents(record.amount, '公司前置'), 0),
    companyBackstopCents: records.filter(record => record.companyKind === 'backstop').reduce((sum, record) => sum + cents(record.amount, '公司兜底'), 0),
    pendingReviewCount: records.filter(record => record.pay === '待复核' || record.pay === '部分缴款').length
  }
  const funding = reconcileProcurementFunding(fundingInput)
  return { project, rule, records, funding, fundingInput }
}

async function distributionSnapshot(projectId: string, session: import('mongodb').ClientSession) {
  const { project, rule, records, funding } = await procurementFundingSnapshot(projectId, session)
  const payment = await procurementPayments.findOne({ projectId }, { session })
  if (!payment || !funding.balanced || !rule.sharePrice || !rule.totalShares) {
    throw new AppError(409, 'DISTRIBUTION_FUNDING_INVALID', '采购付款或认购份数尚未核对闭合')
  }
  const batches = await receiptBatches.find({ 'lines.projectId': projectId }, { session }).toArray()
  const receivableCents = Math.round(project.salesAmount * 100)
  if (!Number.isSafeInteger(receivableCents) || receivableCents <= 0) {
    throw new AppError(409, 'RECEIVABLE_INVALID', '发布时应收金额无效，请先核对众筹单')
  }
  const summary = summarizeProjectReceipts(batches, projectId, receivableCents)
  if (summary.gapCents > 0) throw new AppError(409, 'RECEIPTS_INSUFFICIENT', '累计回款尚未达到应收金额')
  const differences = await receiptDifferences.find({ projectId }, { session }).toArray()
  if (unresolvedReceiptDifference(summary.excessCents, differences).unresolvedCents > 0) {
    throw new AppError(409, 'RECEIPT_DIFFERENCE_PENDING', '存在未处理的回款差异')
  }
  const costRecords = await confirmedCosts.find({ projectId }, { session }).toArray()
  if (costRecords.some(item => item.status === '待公司复核')) {
    throw new AppError(409, 'COST_REVIEW_PENDING', '存在待公司复核的其他成本')
  }
  const confirmedCostsCents = costRecords.filter(item => item.status === '已确认')
    .reduce((sum, item) => sum + item.amountCents, 0)
  if (!Number.isSafeInteger(confirmedCostsCents)) throw new AppError(409, 'COST_AMOUNT_INVALID', '已确认成本金额超出安全范围')
  const employeeShares = new Map<string, number>()
  let companyShares = 0
  for (const record of records) {
    if (record.pay !== '已缴款') continue
    if (!Number.isSafeInteger(record.shares) || record.shares! <= 0) {
      throw new AppError(409, 'DISTRIBUTION_SHARES_INVALID', '认购份数无效')
    }
    if (record.companyKind === 'front' || record.companyKind === 'backstop') companyShares += record.shares!
    else employeeShares.set(record.userId, (employeeShares.get(record.userId) ?? 0) + record.shares!)
  }
  if (companyShares + [...employeeShares.values()].reduce((sum, shares) => sum + shares, 0) !== rule.totalShares) {
    throw new AppError(409, 'DISTRIBUTION_SHARES_INVALID', '公司与员工认购份数未闭合')
  }
  return { project: project as Project, payment, summary, input: {
    sharePriceCents: Math.round(rule.sharePrice * 100), totalShares: rule.totalShares,
    positions: [...[...employeeShares].map(([participantId, shares]) => ({ participantId, kind: 'employee' as const, shares })),
      { participantId: 'company', kind: 'company' as const, shares: companyShares }],
    receivableCents, customerReceiptsCents: summary.customerGrossCents,
    companyTopUpsCents: summary.companyTopUpsCents, companyReturnsCents: summary.companyReturnsCents,
    procurementPaymentsCents: payment.amountCents, confirmedCostsCents
  } }
}

async function financialReconciliationSnapshot(projectId: string, session?: import('mongodb').ClientSession) {
  const { project, funding } = await procurementFundingSnapshot(projectId, session)
  const payment = await procurementPayments.findOne({ projectId }, { session })
  const batches = await receiptBatches.find({ 'lines.projectId': projectId }, { session }).toArray()
  const receivableCents = Math.round(project.salesAmount * 100)
  const receipts = summarizeProjectReceipts(batches, projectId, receivableCents)
  const differences = await receiptDifferences.find({ projectId }, { session }).toArray()
  const costRecords = await confirmedCosts.find({ projectId, status: '已确认' }, { session }).toArray()
  const costCents = costRecords.reduce((sum, record) => sum + record.amountCents, 0)
  const ledgerEntries = await mongo.db.collection<{ projectId: string; type: string; amountCents: number }>(
    `${appConfig.mongodb.collectionPrefix}fund_ledger`).find({ projectId }, { session }).toArray()
  const ledgerTotal = (type: string) => ledgerEntries.filter(entry => entry.type === type)
    .reduce((sum, entry) => sum + entry.amountCents, 0)
  const orders = await distributionOrders.find({ projectId }, { session }).sort({ createdAt: -1 }).toArray()
  const active = orders.find(distributionOrderIsActive)
  const exceptions = await exceptionFunds.find({ projectId }, { session }).toArray()
  const reconciled = reconcileProjectFinancials({ purchaseCents: funding.purchaseCents,
    approvedEmployeeCents: funding.employeeCents,
    confirmedCompanyCents: payment ? funding.companyCents : 0,
    procurementPaymentCents: payment?.amountCents ?? 0, receivableCents,
    distributableReceiptsCents: Math.min(receipts.distributableCents, receivableCents),
    unresolvedReceiptDifferenceCents: unresolvedReceiptDifference(receipts.excessCents, differences).unresolvedCents,
    confirmedCostsCents: costCents, confirmedCostLedgerCents: ledgerTotal('other_confirmed_cost'),
    orderStatus: active?.status, orderPayoutTotalCents: active?.payoutTotalCents,
    orderLinesCents: active?.lines.reduce((sum, line) => sum + line.payoutCents, 0),
    payoutLedgerCents: ledgerTotal('employee_distribution_payout') + ledgerTotal('company_internal_transfer'),
    unprocessedExceptionCents: exceptions.reduce((sum, item) => sum + item.remainingCents, 0) })
  return { project, order: active, data: { projectId, checkedAt: new Date().toISOString(), ...reconciled } }
}

function addHours(datetime: string, hours: number) {
  const date = parseDateTime(datetime)
  date.setHours(date.getHours() + hours)
  return formatDateTime(date)
}

async function pushAudit(entry: Omit<AuditLog, 'time' | 'result'> & { result?: AuditLog['result'] }) {
  auditLogs.unshift({ id: `AUD-${Date.now()}-${randomUUID()}`, requestId: currentRequestId(), time: now(), result: entry.result ?? '成功', ...entry } as AuditLog)
  await persistState()
}

function send(res: ServerResponse, status: number, payload: unknown) {
  sendJson(res.req, res, iamConfig.allowedOrigin, status, payload)
}

function auditRecord(input: Omit<AuditLog, 'time' | 'result'> & { result?: AuditLog['result'] }) {
  return { id: `AUD-${Date.now()}-${randomUUID()}`, requestId: currentRequestId(), time: now(), result: input.result ?? '成功', ...input }
}

let backstopRunning = false
async function runDueBackstops() {
  if (backstopRunning) return
  backstopRunning = true
  try {
    const openProjects = await repositories.projects.list({ status: { $in: ['未满额', '已满额'] } } as never)
    for (const candidate of openProjects) {
      try {
        if (!candidate.ruleId) continue
        const rule = await repositories.rules.getById(candidate.ruleId)
        if (!rule?.sharePrice || !rule.companyTakeover) continue
        const result = await mongo.withTransaction(async session => {
          const project = await repositories.projects.getById(candidate.id, session)
          if (!project || !['未满额', '已满额'].includes(project.status)) return null
          const records = await repositories.subscriptions.list({ projectId: project.id } as never, {}, session)
          if (records.some(record => record.companyKind === 'backstop')) return null
          const employees = records.filter(record => record.shares !== undefined && !isCompanySubscription(record as Subscription))
          const cutoffInput = { subscriptionCutoffAt: project.deadline, paymentCutoffAt: rule.paymentCutoffAt,
            employeePaymentDeadlines: employees.map(record => record.paymentDeadlineAt),
            unresolvedReviewCount: employees.filter(record => record.pay === '待复核' || record.pay === '部分缴款').length }
          const currentTime = new Date()
          if (cutoffInput.unresolvedReviewCount > 0) return null
          if (currentTime.getTime() < paymentCutoffTime(cutoffInput)) return null
          const released = employees.filter(record => record.pay === '未缴款' || record.pay === '复核驳回')
          const releasedCents = released.reduce((sum, record) => sum + Math.round(record.amount * 100), 0)
          const remainingAmount = (Math.round(project.remain * 100) + releasedCents) / 100
          const backstop = planCompanyBackstop({
            status: project.status, sharePrice: rule.sharePrice, remainingAmount,
            ...cutoffInput, companyTakeover: true
          }, currentTime)
          if (!backstop && released.length === 0) return null

          const nextProject = { ...project }
          nextProject.employeeSubscribedAmount = Math.max(0, Math.round((nextProject.employeeSubscribedAmount - releasedCents / 100) * 100) / 100)
          nextProject.people = Math.max(0, nextProject.people - released.length)
          if (backstop) {
            nextProject.companyTakeoverAmount = Math.round((nextProject.companyTakeoverAmount + backstop.amount) * 100) / 100
            nextProject.companyBackstopShares = backstop.shares
          }
          normalizeProjectAmounts(nextProject as Project)
          if (nextProject.remain === 0) {
            nextProject.status = '已满额'
            nextProject.statusType = 'success'
          }
          const releasedRecords = released.map(record => ({ ...record, pay: '已释放' as const, action: '已释放' }))
          for (const record of releasedRecords) await repositories.subscriptions.replace(record, session)
          let companyRecord: Subscription | undefined
          if (backstop) {
            companyRecord = {
              id: `SUB-COMPANY-BACKSTOP-${project.id}`, projectId: project.id, project: project.title,
              userId: 'company', companyKind: 'backstop', amount: backstop.amount, shares: backstop.shares,
              pay: '公司待出资', profit: project.profitAmount, action: '财务确认公司出资',
              idempotencyKey: `system:company-backstop:${project.id}`,
              createdAt: now(), paymentDeadlineAt: now()
            }
            await repositories.subscriptions.insert(companyRecord, session)
          }
          await repositories.projects.replace(nextProject, session)
          const audit = auditRecord({
            actor: '系统', role: 'system', action: '缴款期限结束后公司自动兜底', target: project.id,
            before: { status: project.status, remain: project.remain },
            after: { status: nextProject.status, releasedSubscriptionIds: released.map(record => record.id), backstopShares: backstop?.shares ?? 0, backstopAmount: backstop?.amount ?? 0, companyFundsConfirmed: false }
          }) as AuditLog
          await repositories.auditLogs.insert(audit as never, session)
          return { project: nextProject, releasedRecords, companyRecord, audit }
        })
        if (!result) continue
        const index = projects.findIndex(project => project.id === result.project.id)
        if (index >= 0) projects.splice(index, 1, result.project as Project)
        for (const record of result.releasedRecords) {
          const subscriptionIndex = subscriptions.findIndex(item => item.id === record.id)
          if (subscriptionIndex >= 0) subscriptions.splice(subscriptionIndex, 1, record as Subscription)
        }
        if (result.companyRecord) subscriptions.unshift(result.companyRecord)
        auditLogs.unshift(result.audit)
      } catch (error) {
        logFailure('company.backstop.project', error)
      }
    }
  } finally {
    backstopRunning = false
  }
}

function uploadActor(fields: Record<string, string>, fallback: string) {
  const operator = fields.operator?.trim() || fallback
  return { userId: operator.split(' · ')[0] || fallback, label: operator }
}

function receivingCodeManager(req: IncomingMessage) {
  const context = requestContext(req)
  const role = context.role
  if (role !== 'admin' && role !== 'finance') throw new AppError(403, 'FORBIDDEN', '只有管理员或财务可以维护收款码')
  return { userId: context.userId, role, label: `${context.userId} · ${role === 'admin' ? '管理员' : '财务'}` }
}

function iamDisplayName(req: IncomingMessage) {
  const identity = iamContextFor(req)
  return identity.user?.nickname?.trim() || identity.user?.username?.trim() || identity.userId
}

function managementActor(req: IncomingMessage, allowedRoles: Role[]) {
  const context = requestContext(req)
  if (!allowedRoles.includes(context.role)) throw new AppError(403, 'FORBIDDEN', '当前角色无权执行该管理操作')
  return { ...context, label: `${context.userId} · ${context.role === 'super_admin' ? '公司超级管理员' : '管理员'}` }
}

function financeOperator(req: IncomingMessage) {
  const context = requestContext(req)
  if (context.role !== 'finance') throw new AppError(403, 'FORBIDDEN', '只有财务可以执行结算操作')
  return { ...context, label: `${context.userId} · 财务` }
}

function ephemeralDataUrl(image: ValidatedImage) {
  return `data:${image.mimeType};base64,${image.bytes.toString('base64')}`
}

async function readValidatedUpload(
  req: IncomingMessage,
  allowedFields: readonly string[],
  allowedMimeTypes: readonly ValidatedImage['mimeType'][]
) {
  const multipart = await readSingleImageMultipart(req, {
    maxFileBytes: 5 * 1024 * 1024,
    maxFieldBytes: 4 * 1024,
    allowedFields
  })
  return {
    fields: multipart.fields,
    image: validateImageFile({ ...multipart.file, maxBytes: 5 * 1024 * 1024, allowedMimeTypes })
  }
}

async function routeGet(url: URL, req: IncomingMessage, res: ServerResponse) {
  const { pathname, searchParams } = url
  if (pathname === '/api/health') return send(res, 200, { ok: true, service: 'subscription-api', persistence: 'mongodb', database: appConfig.mongodb.database, time: new Date().toISOString() })
  if (pathname === '/api/agreements/current') {
    requestContext(req)
    const current = await agreementService.current()
    return send(res, 200, { data: current ? { ...current, status: '生效中' } : null })
  }
  if (pathname === '/api/agreements') {
    managementActor(req, ['super_admin'])
    const page = Math.max(1, Math.min(100000, Number(searchParams.get('page')) || 1))
    const pageSize = Math.max(1, Math.min(100, Number(searchParams.get('pageSize')) || 10))
    const result = await agreementService.list(page, pageSize)
    return send(res, 200, { data: { ...result, items: result.items.map((item, index) => ({ ...item, status: page === 1 && index === 0 ? '生效中' : '已失效' })) } })
  }
  const agreementConfirmationsMatch = pathname.match(/^\/api\/agreements\/(\d+)\/confirmations$/)
  if (agreementConfirmationsMatch) {
    managementActor(req, ['super_admin'])
    const page = Math.max(1, Math.min(100000, Number(searchParams.get('page')) || 1))
    const pageSize = Math.max(1, Math.min(100, Number(searchParams.get('pageSize')) || 10))
    const userId = searchParams.get('userId')?.trim() || undefined
    const node = searchParams.get('node')?.trim() as AgreementNode | undefined
    const from = searchParams.get('from')?.trim() || undefined
    const to = searchParams.get('to')?.trim() || undefined
    if (node && !['提交认购', '查看缴款码', '确认收款'].includes(node)) return send(res, 400, { error: 'AGREEMENT_NODE_INVALID', message: '确认节点无效' })
    if ([from, to].some(value => value && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value))) return send(res, 400, { error: 'AGREEMENT_TIME_INVALID', message: '确认时间格式无效' })
    return send(res, 200, { data: await agreementService.listConfirmations(Number(agreementConfirmationsMatch[1]), page, pageSize, { userId, node, from, to }) })
  }
  const fileMatch = pathname.match(/^\/api\/files\/([^/]+)\/content$/)
  if (fileMatch) {
    const context = requestContext(req)
    const asset = await fileAssetService.getReadyAsset(decodeURIComponent(fileMatch[1]))
    if (!asset) return send(res, 404, { error: 'FILE_NOT_FOUND', message: '文件不存在或无权访问' })
    if (asset.purpose === 'exception-refund-proof' && context.role === 'employee') {
      const owned = await exceptionFunds.findOne({ payerUserId: context.userId,
        'allocations.proofAssetIds': asset.id })
      if (!owned) return send(res, 404, { error: 'FILE_NOT_FOUND', message: '文件不存在或无权访问' })
    } else await authorizeAssetRead(context, asset, repositories)
    if (asset.purpose === 'receiving-code' && context.role === 'employee') {
      const current = await agreementService.current()
      const accepted = current && await agreementService.hasRecentCodeConfirmation(context.userId, asset.ownerId, current.version, new Date(Date.now() - 5 * 60_000))
      if (!accepted) return send(res, 404, { error: 'FILE_NOT_FOUND', message: '文件不存在或无权访问' })
    }
    res.writeHead(200, {
      'Content-Type': asset.mimeType,
      'Content-Length': String(asset.sizeBytes),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff'
    })
    const stream = fileAssetService.openReadStream(asset)
    stream.once('error', () => {
      if (!res.headersSent) send(res, 503, { error: 'STORAGE_UNAVAILABLE', message: '图片存储暂不可用' })
      else res.destroy()
    })
    stream.pipe(res)
    return
  }
  if (pathname === '/api/state') {
    const context = requestContext(req)
    if (context.role === 'employee' || context.role === 'admin') throw new AppError(403, 'FORBIDDEN', '当前角色不能访问全量业务状态')
    return send(res, 200, { data: await queryService.state(), persistence: 'mongodb' })
  }
  if (pathname === '/api/projects') {
    const role = requestContext(req).role
    const listed = await queryService.listProjects(requestContext(req))
    if (role !== 'admin') return send(res, 200, { data: listed })
    const identity = iamContextFor(req)
    return send(res, 200, { data: listed.filter(project => project.status === '未开放'
      || (project.tenantId === identity.tenantId && project.ownerUserId === identity.userId)) })
  }
  const fundingMatch = pathname.match(/^\/api\/projects\/([^/]+)\/funding-reconciliation$/)
  if (fundingMatch) {
    const role = requestContext(req).role
    if (role !== 'finance' && role !== 'super_admin') throw new AppError(403, 'FORBIDDEN', '只有财务或公司管理员可以查看付款前对账')
    const projectId = decodeURIComponent(fundingMatch[1])
    const { funding } = await procurementFundingSnapshot(projectId)
    const payment = await procurementPayments.findOne({ projectId })
    return send(res, 200, { data: { projectId, ...funding,
      companyContributionIsCommitment: !payment, companyFundsConfirmed: Boolean(payment), checkedAt: new Date().toISOString() } })
  }
  if (pathname === '/api/receipt-batches') {
    const role = requestContext(req).role
    if (role !== 'finance' && role !== 'super_admin') throw new AppError(403, 'FORBIDDEN', '只有财务或公司可以查看回款')
    const projectId = searchParams.get('projectId')?.trim()
    const kind = searchParams.get('kind')?.trim()
    const status = searchParams.get('status')?.trim()
    if (kind && kind !== '客户回款' && kind !== '公司补款') return send(res, 400, { error: 'RECEIPT_KIND_INVALID', message: '回款类型无效' })
    if (status && status !== '待复核' && status !== '已通过' && status !== '已驳回') return send(res, 400, { error: 'RECEIPT_STATUS_INVALID', message: '复核状态无效' })
    const page = Math.max(1, Math.min(100000, Number(searchParams.get('page')) || 1))
    const pageSize = Math.max(1, Math.min(100, Number(searchParams.get('pageSize')) || 10))
    const filter: import('mongodb').Filter<ReceiptBatch> = {
      ...(projectId ? { 'lines.projectId': projectId } : {}),
      ...(kind ? { kind: kind as ReceiptBatch['kind'] } : {}),
      ...(status ? { status: status as ReceiptBatch['status'] } : {})
    }
    const [items, total] = await Promise.all([
      receiptBatches.find(filter).sort({ bookedAt: -1, id: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
      receiptBatches.countDocuments(filter)
    ])
    return send(res, 200, { data: { items, total, page, pageSize } })
  }
  const receiptSummaryMatch = pathname.match(/^\/api\/projects\/([^/]+)\/receipt-summary$/)
  if (receiptSummaryMatch) {
    const role = requestContext(req).role
    if (role !== 'finance' && role !== 'super_admin') throw new AppError(403, 'FORBIDDEN', '只有财务或公司可以查看回款对账')
    const projectId = decodeURIComponent(receiptSummaryMatch[1])
    const project = await repositories.projects.getById(projectId)
    if (!project) return send(res, 404, { error: 'PROJECT_NOT_FOUND', message: '众筹单不存在' })
    const batches = await receiptBatches.find({ 'lines.projectId': projectId }).toArray()
    const differences = await receiptDifferences.find({ projectId }).sort({ createdAt: -1 }).toArray()
    const receivableCents = Math.round(project.salesAmount * 100)
    const receipts = summarizeProjectReceipts(batches, projectId, receivableCents)
    return send(res, 200, { data: { projectId, receivableCents,
      ...receipts, ...unresolvedReceiptDifference(receipts.excessCents, differences), differences } })
  }
  if (pathname === '/api/distribution-orders') {
    const role = requestContext(req).role
    if (role !== 'finance' && role !== 'super_admin') throw new AppError(403, 'FORBIDDEN', '当前角色无权查看分配单')
    const projectId = searchParams.get('projectId')?.trim()
    const page = Math.max(1, Math.min(100000, Number(searchParams.get('page')) || 1))
    const pageSize = Math.max(1, Math.min(100, Number(searchParams.get('pageSize')) || 10))
    const filter = projectId ? { projectId } : {}
    const [items, total] = await Promise.all([
      distributionOrders.find(filter).sort({ createdAt: -1, id: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
      distributionOrders.countDocuments(filter)
    ])
    return send(res, 200, { data: { items, total, page, pageSize } })
  }
  if (pathname === '/api/my-distribution-payouts') {
    const context = requestContext(req)
    if (context.role !== 'employee') throw new AppError(403, 'FORBIDDEN', '仅员工本人可以查看我的收益')
    const orders = await distributionOrders.find({ 'lines.participantId': context.userId,
      status: { $nin: ['待审批', '已驳回', '已作废'] } }).sort({ createdAt: -1 }).limit(100).toArray()
    return send(res, 200, { data: orders.map(order => ({ orderId: order.id, projectId: order.projectId,
      orderStatus: order.status, line: order.lines.find(line => line.participantId === context.userId) })) })
  }
  const financialReconciliationMatch = pathname.match(/^\/api\/projects\/([^/]+)\/financial-reconciliation$/)
  if (financialReconciliationMatch) {
    const role = requestContext(req).role
    if (role !== 'finance' && role !== 'super_admin') throw new AppError(403, 'FORBIDDEN', '当前角色无权查看结单前对账')
    const projectId = decodeURIComponent(financialReconciliationMatch[1])
    const snapshot = await financialReconciliationSnapshot(projectId)
    return send(res, 200, { data: snapshot.data })
  }
  if (pathname === '/api/confirmed-costs') {
    const role = requestContext(req).role
    if (role !== 'finance' && role !== 'super_admin') throw new AppError(403, 'FORBIDDEN', '当前角色无权查看其他成本')
    const projectId = searchParams.get('projectId')?.trim()
    const filter = projectId ? { projectId } : {}
    const items = await confirmedCosts.find(filter).sort({ createdAt: -1, id: -1 }).limit(200).toArray()
    return send(res, 200, { data: items })
  }
  if (pathname === '/api/exception-funds') {
    const role = requestContext(req).role
    if (role !== 'finance' && role !== 'super_admin') throw new AppError(403, 'FORBIDDEN', '当前角色无权查看异常款项')
    const projectId = searchParams.get('projectId')?.trim()
    const status = searchParams.get('status')?.trim()
    if (status && !['待处理', '退回待确认', '转入待复核', '已处理'].includes(status)) {
      return send(res, 400, { error: 'EXCEPTION_STATUS_INVALID', message: '异常款项状态无效' })
    }
    const page = Math.max(1, Math.min(100000, Number(searchParams.get('page')) || 1))
    const pageSize = Math.max(1, Math.min(100, Number(searchParams.get('pageSize')) || 10))
    const filter: import('mongodb').Filter<ExceptionFund> = {
      ...(projectId ? { projectId } : {}), ...(status ? { status: status as ExceptionFund['status'] } : {}) }
    const [items, total] = await Promise.all([
      exceptionFunds.find(filter).sort({ bookedAt: -1, id: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
      exceptionFunds.countDocuments(filter)
    ])
    return send(res, 200, { data: { items, total, page, pageSize } })
  }
  if (pathname === '/api/my-exception-refunds') {
    const context = requestContext(req)
    if (context.role !== 'employee') throw new AppError(403, 'FORBIDDEN', '只有员工本人可以查看退款确认')
    const records = await exceptionFunds.find({ payerUserId: context.userId,
      'allocations.kind': '退回' }).sort({ createdAt: -1 }).limit(100).toArray()
    return send(res, 200, { data: records.flatMap(record => record.allocations
      .filter(allocation => allocation.kind === '退回' && allocation.recipientUserId === context.userId)
      .map(allocation => ({ fundId: record.id, projectId: record.projectId,
        transactionNo: record.transactionNo, allocation }))) })
  }
  if (pathname === '/api/project-refunds') {
    const role = requestContext(req).role
    if (role !== 'finance' && role !== 'super_admin') throw new AppError(403, 'FORBIDDEN', '当前角色无权查看项目退款')
    const projectId = searchParams.get('projectId')?.trim()
    const page = Math.max(1, Math.min(100000, Number(searchParams.get('page')) || 1))
    const pageSize = Math.max(1, Math.min(100, Number(searchParams.get('pageSize')) || 10))
    const filter = projectId ? { projectId } : {}
    const [items, total] = await Promise.all([
      projectRefunds.find(filter).sort({ createdAt: -1, id: -1 }).skip((page - 1) * pageSize).limit(pageSize).toArray(),
      projectRefunds.countDocuments(filter)
    ])
    return send(res, 200, { data: { items, total, page, pageSize } })
  }
  if (pathname === '/api/my-project-refunds') {
    const context = requestContext(req)
    if (context.role !== 'employee') throw new AppError(403, 'FORBIDDEN', '只有员工本人可以查看自己的退款')
    const records = await projectRefunds.find({ participantId: context.userId })
      .sort({ createdAt: -1 }).limit(100).toArray()
    return send(res, 200, { data: records })
  }
  if (pathname === '/api/receiving-codes') {
    const context = requestContext(req)
    const codes = await queryService.listReceivingCodes()
    if (context.role !== 'employee') return send(res, 200, { data: codes })
    const projectIds = new Set((await queryService.listSubscriptions(context))
      .filter(item => item.pay !== '已释放').map(item => item.projectId))
    const codeIds = new Set(rules.filter(rule => projectIds.has(rule.projectId)).map(rule => rule.receivingCodeId))
    return send(res, 200, { data: codes.filter(code => codeIds.has(code.id)).map(({ imageAssetId: _imageAssetId, imageUrl: _imageUrl, ...code }) => code) })
  }
  const procurementDetailMatch = pathname.match(/^\/api\/procurement\/orders\/([^/]+)$/)
  if (procurementDetailMatch) {
    const projectId = decodeURIComponent(procurementDetailMatch[1])
    const project = projects.find(item => item.id === projectId)
    if (!project) return send(res, 404, { error: 'PROJECT_NOT_FOUND', message: '项目不存在' })
    if (requestContext(req).role === 'admin' && project.status !== '未开放') requireAdminOwned(req, project)

    const externalId = project.id.match(/^PRJ-FSY-OFFLINE-(.+)$/)?.[1]
    if (!externalId) return send(res, 400, { error: 'PROCUREMENT_PROJECT_REQUIRED', message: '该项目不是采购系统同步项目，无法查询采购订单详情' })

    const projectName = searchParams.get('projectName')?.trim() || project.title
    const result = await fetchProcurementPage({
      baseUrl: process.env.PROCUREMENT_API_URL ?? 'https://prod-api-admin.fushangyunfu.com/admin-api/erp/offline-order/page',
      token: process.env.PROCUREMENT_TOKEN ?? '',
      projectName
    })
    const order = result.items.find(item => String(item.id ?? '').trim() === externalId)
    if (!order) return send(res, 404, { error: 'PROCUREMENT_ORDER_NOT_FOUND', message: '未找到与当前项目匹配的采购订单' })
    return send(res, 200, { data: mapProcurementOrderToDetail(order) })
  }
  if (pathname === '/api/rules') {
    const keyword = searchParams.get('keyword')?.trim()
    const status = searchParams.get('status')?.trim()
    const projectId = searchParams.get('projectId')?.trim()
    const filtered = rules.filter(rule => {
      if (requestContext(req).role === 'admin' && !isOwnedByAdmin(req, rule)) return false
      const keywordMatched = !keyword || [rule.ruleName, rule.projectName, rule.id].some(value => value.includes(keyword))
      const statusMatched = !status || status === '全部' || rule.status === status
      const projectMatched = !projectId || projectId === '全部' || rule.projectId === projectId
      return keywordMatched && statusMatched && projectMatched
    })
    return send(res, 200, { data: filtered })
  }
  if (pathname === '/api/subscriptions') {
    if (requestContext(req).role !== 'admin') return send(res, 200, { data: await queryService.listSubscriptions(requestContext(req)) })
    const ownedIds = projects.filter(project => isOwnedByAdmin(req, project)).map(project => project.id)
    const records = await repositories.subscriptions.list({ projectId: { $in: ownedIds } }, { sort: { createdAt: -1, id: -1 } })
    return send(res, 200, { data: records.map(record => ({
      id: record.id, projectId: record.projectId, userId: record.userId, amount: record.amount,
      shares: record.shares, companyKind: record.companyKind, pay: record.pay,
      createdAt: record.createdAt, paymentDeadlineAt: record.paymentDeadlineAt
    })) })
  }
  if (pathname === '/api/audit-logs') {
    const context = requestContext(req)
    if (context.role === 'employee' || context.role === 'admin') throw new AppError(403, 'FORBIDDEN', '当前角色不能查看全量审计日志')
    return send(res, 200, { data: await repositories.auditLogs.list({}, { sort: { time: -1 } }) })
  }
  if (pathname === '/api/risk-events') {
    const context = requestContext(req)
    if (context.role === 'employee' || context.role === 'admin') throw new AppError(403, 'FORBIDDEN', '当前角色不能查看全量风险事件')
    return send(res, 200, { data: await repositories.riskEvents.list({}, { sort: { time: -1 } }) })
  }
  if (pathname === '/api/rbac') {
    return send(res, 200, {
      data: [
        { feature: '员工认购', employee: 'C/R/U(本人)', admin: 'R', finance: 'R', super: 'R' },
        { feature: 'OCR 复核', employee: '—', admin: 'R', finance: 'R/U/A', super: 'R/U/A' },
        { feature: '公司兜底', employee: '—', admin: 'R', finance: 'R', super: 'R/U/X' },
        { feature: '审计日志', employee: '—', admin: 'R', finance: 'R(财务相关)', super: 'R' }
      ]
    })
  }
  return send(res, 404, { error: 'NOT_FOUND', message: '接口不存在' })
}

function validateRulePayload(body: Record<string, unknown>, res: ServerResponse) {
  const project = projects.find(item => item.id === body.projectId)
  if (!project) {
    send(res, 404, { error: 'PROJECT_NOT_FOUND', message: '项目不存在，不能保存认购规则' })
    return null
  }
  let shareRule: ReturnType<typeof prepareShareRule> | undefined
  if (body.sharePrice !== undefined && body.sharePrice !== null && body.sharePrice !== '') {
    try {
      shareRule = prepareShareRule(project.costAmount, Number(body.sharePrice), Number(body.companyFrontShares),
        body.maxSharesPerEmployee === undefined || body.maxSharesPerEmployee === '' ? undefined : Number(body.maxSharesPerEmployee))
      validatePublishSchedule({ subscriptionCutoffAt: body.endAt, paymentCutoffAt: body.paymentCutoffAt,
        plannedPaymentDate: body.plannedPaymentDate })
    } catch (error) {
      send(res, 400, { error: 'SHARE_RULE_INVALID', message: error instanceof Error ? error.message : '份额规则无效' })
      return null
    }
  }
  const companyFixedAmount = shareRule?.companyFixedAmount ?? Number(body.companyFixedAmount ?? 0)
  const minParticipants = shareRule ? 1 : Number(body.minParticipants)
  const receivingCodeId = String(body.receivingCodeId ?? '').trim()
  if (typeof body.ruleName !== 'string' || !body.ruleName.trim()) {
    send(res, 400, { error: 'RULE_NAME_REQUIRED', message: '请输入规则名称' })
    return null
  }
  if (!receivingCodeId) {
    send(res, 400, { error: 'RECEIVING_CODE_REQUIRED', message: '请选择项目收款码' })
    return null
  }
  const receivingCode = receivingCodes.find(item => item.id === receivingCodeId)
  if (!receivingCode) {
    send(res, 404, { error: 'RECEIVING_CODE_NOT_FOUND', message: '项目收款码不存在' })
    return null
  }
  if (receivingCode.status !== '启用') {
    send(res, 409, { error: 'RECEIVING_CODE_DISABLED', message: '项目收款码已禁用，请选择当前启用的收款码' })
    return null
  }
  if (!Number.isFinite(companyFixedAmount) || companyFixedAmount < 0) {
    send(res, 400, { error: 'COMPANY_FIXED_AMOUNT_INVALID', message: '公司固定认购金额不能低于 0 元' })
    return null
  }
  if (companyFixedAmount >= project.costAmount) {
    send(res, 400, { error: 'COMPANY_FIXED_AMOUNT_EXCEEDS_PROJECT_COST', message: '公司固定认购金额必须小于项目成本金额' })
    return null
  }
  if (!Number.isFinite(minParticipants) || minParticipants < 1) {
    send(res, 400, { error: 'MIN_PARTICIPANTS_INVALID', message: '开放参与人数不能低于 1' })
    return null
  }
  const totalAmount = shareRule?.totalAmount ?? Math.max(0, project.costAmount - companyFixedAmount)
  if (totalAmount <= 0) {
    send(res, 400, { error: 'TOTAL_AMOUNT_INVALID', message: '开放认购金额必须大于 0 元' })
    return null
  }
  const minAmount = shareRule?.sharePrice ?? Math.ceil(totalAmount / minParticipants)
  return { project, totalAmount, companyFixedAmount, minAmount, minParticipants, receivingCodeId, shareRule }
}

async function routePost(pathname: string, req: IncomingMessage, res: ServerResponse) {
  if (pathname === '/api/agreements') {
    const actor = managementActor(req, ['super_admin'])
    const body = await readJsonBody(req, 16 * 1024)
    const created = await agreementService.create({ title: body.title, body: body.body, createdBy: actor.label })
    await repositories.auditLogs.insert(auditRecord({ actor: actor.label, role: actor.role, action: '新增免责协议版本', target: created.id, before: null, after: { version: created.version, title: created.title } }) as never)
    return send(res, 201, { data: created, message: '新版本已生效' })
  }
  const exceptionProofMatch = pathname.match(/^\/api\/exception-funds\/proofs$/)
  if (exceptionProofMatch) {
    const actor = financeOperator(req)
    const multipart = await readSingleImageMultipart(req, { maxFileBytes: 10 * 1024 * 1024,
      maxFieldBytes: 1024, allowedFields: [] })
    const image = validateImageFile({ ...multipart.file, maxBytes: 10 * 1024 * 1024,
      allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp'] })
    const ownerId = `exception-staging:${actor.userId}`
    const existing = await repositories.fileAssets.count({ ownerType: 'project', ownerId,
      purpose: 'exception-fund-proof', status: 'ready' })
    if (existing >= 50) return send(res, 429, { error: 'EXCEPTION_PROOF_LIMIT', message: '暂存异常款项凭证已达上限' })
    const asset = await fileAssetService.uploadUnbound({ ...image, purpose: 'exception-fund-proof',
      ownerType: 'project', ownerId, createdBy: actor.userId })
    return send(res, 201, { data: { id: asset.id, fileName: asset.originalName }, message: '异常款项凭证已保存' })
  }
  const exceptionRefundProofMatch = pathname.match(/^\/api\/exception-funds\/([^/]+)\/refund-proofs$/)
  if (exceptionRefundProofMatch) {
    const actor = financeOperator(req)
    const fundId = decodeURIComponent(exceptionRefundProofMatch[1])
    const fund = await exceptionFunds.findOne({ id: fundId })
    if (!fund || fund.remainingCents <= 0) return send(res, 409, { error: 'EXCEPTION_FUND_INVALID', message: '该异常款项不可退回' })
    const multipart = await readSingleImageMultipart(req, { maxFileBytes: 10 * 1024 * 1024,
      maxFieldBytes: 1024, allowedFields: [] })
    const image = validateImageFile({ ...multipart.file, maxBytes: 10 * 1024 * 1024,
      allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp'] })
    const ownerId = `exception-refund-staging:${fundId}:${actor.userId}`
    const existing = await repositories.fileAssets.count({ ownerType: 'project', ownerId,
      purpose: 'exception-refund-proof', status: 'ready' })
    if (existing >= 50) return send(res, 429, { error: 'EXCEPTION_REFUND_PROOF_LIMIT', message: '暂存退回凭证已达上限' })
    const asset = await fileAssetService.uploadUnbound({ ...image, purpose: 'exception-refund-proof',
      ownerType: 'project', ownerId, createdBy: actor.userId })
    return send(res, 201, { data: { id: asset.id, fileName: asset.originalName }, message: '退回凭证已保存' })
  }
  const projectRefundProofMatch = pathname.match(/^\/api\/project-refunds\/([^/]+)\/proofs$/)
  if (projectRefundProofMatch) {
    const actor = financeOperator(req)
    const refundId = decodeURIComponent(projectRefundProofMatch[1])
    const refund = await projectRefunds.findOne({ id: refundId })
    if (!refund || refund.status !== '待退款') {
      return send(res, 409, { error: 'PROJECT_REFUND_INVALID', message: '该退款事项当前不可上传凭证' })
    }
    const multipart = await readSingleImageMultipart(req, { maxFileBytes: 10 * 1024 * 1024,
      maxFieldBytes: 1024, allowedFields: [] })
    const image = validateImageFile({ ...multipart.file, maxBytes: 10 * 1024 * 1024,
      allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp'] })
    const existing = await repositories.fileAssets.count({ ownerType: 'subscription', ownerId: refund.subscriptionId,
      purpose: 'subscription-refund-proof', status: 'ready' })
    if (existing >= 50) return send(res, 429, { error: 'PROJECT_REFUND_PROOF_LIMIT', message: '该退款事项暂存凭证已达上限' })
    const asset = await fileAssetService.uploadUnbound({ ...image, purpose: 'subscription-refund-proof',
      ownerType: 'subscription', ownerId: refund.subscriptionId, createdBy: actor.userId })
    return send(res, 201, { data: { id: asset.id, fileName: asset.originalName }, message: '退款凭证已保存' })
  }
  const receiptProofMatch = pathname.match(/^\/api\/projects\/([^/]+)\/receipt-proofs$/)
  if (receiptProofMatch) {
    const actor = financeOperator(req)
    const projectId = decodeURIComponent(receiptProofMatch[1])
    const project = await repositories.projects.getById(projectId)
    if (!project || !['待回款', '回款中', '待分配'].includes(project.status)
      || !await procurementPayments.findOne({ projectId })) {
      return send(res, 409, { error: 'PROJECT_NOT_RECEIPT_READY', message: '众筹单尚未完成采购付款或已关闭回款' })
    }
    const multipart = await readSingleImageMultipart(req, { maxFileBytes: 10 * 1024 * 1024,
      maxFieldBytes: 1024, allowedFields: [] })
    const image = validateImageFile({ ...multipart.file, maxBytes: 10 * 1024 * 1024,
      allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp'] })
    const existing = await repositories.fileAssets.count({ ownerType: 'project', ownerId: projectId,
      purpose: 'customer-receipt-proof', status: 'ready' })
    if (existing >= 50) return send(res, 429, { error: 'RECEIPT_PROOF_LIMIT', message: '该众筹单暂存回款凭证已达上限' })
    const asset = await fileAssetService.uploadUnbound({ ...image, purpose: 'customer-receipt-proof',
      ownerType: 'project', ownerId: projectId, createdBy: actor.userId })
    return send(res, 201, { data: { id: asset.id, fileName: asset.originalName }, message: '回款凭证已保存，待登记回款' })
  }
  const costProofMatch = pathname.match(/^\/api\/projects\/([^/]+)\/confirmed-cost-proofs$/)
  if (costProofMatch) {
    const actor = financeOperator(req)
    const projectId = decodeURIComponent(costProofMatch[1])
    const project = await repositories.projects.getById(projectId)
    if (!project || !['待回款', '回款中', '待分配'].includes(project.status)
      || !await procurementPayments.findOne({ projectId })) {
      return send(res, 409, { error: 'COST_PROJECT_INVALID', message: '众筹单不允许登记其他成本' })
    }
    const multipart = await readSingleImageMultipart(req, { maxFileBytes: 10 * 1024 * 1024,
      maxFieldBytes: 1024, allowedFields: [] })
    const image = validateImageFile({ ...multipart.file, maxBytes: 10 * 1024 * 1024,
      allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp'] })
    const existing = await repositories.fileAssets.count({ ownerType: 'project', ownerId: projectId,
      purpose: 'confirmed-cost-proof', status: 'ready' })
    if (existing >= 50) return send(res, 429, { error: 'COST_PROOF_LIMIT', message: '该众筹单暂存成本凭证已达上限' })
    const asset = await fileAssetService.uploadUnbound({ ...image, purpose: 'confirmed-cost-proof',
      ownerType: 'project', ownerId: projectId, createdBy: actor.userId })
    return send(res, 201, { data: { id: asset.id, fileName: asset.originalName }, message: '成本凭证已保存' })
  }
  const payoutProofMatch = pathname.match(/^\/api\/distribution-orders\/([^/]+)\/lines\/([^/]+)\/proofs$/)
  if (payoutProofMatch) {
    const actor = financeOperator(req)
    const orderId = decodeURIComponent(payoutProofMatch[1])
    const participantId = decodeURIComponent(payoutProofMatch[2])
    const order = await distributionOrders.findOne({ id: orderId })
    const line = order?.lines.find(item => item.participantId === participantId)
    if (!order || !line || line.kind !== 'employee' || line.status !== '待登记打款'
      || !['已审批', '打款登记中'].includes(order.status)) {
      return send(res, 409, { error: 'PAYOUT_LINE_INVALID', message: '该员工明细当前不可上传打款凭证' })
    }
    const subscription = await repositories.subscriptions.findOne({ projectId: order.projectId,
      userId: participantId, pay: '已缴款' })
    if (!subscription) return send(res, 409, { error: 'PAYOUT_SUBSCRIPTION_INVALID', message: '员工认购单不存在' })
    const multipart = await readSingleImageMultipart(req, { maxFileBytes: 10 * 1024 * 1024,
      maxFieldBytes: 1024, allowedFields: [] })
    const image = validateImageFile({ ...multipart.file, maxBytes: 10 * 1024 * 1024,
      allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp'] })
    const existing = await repositories.fileAssets.count({ ownerType: 'subscription', ownerId: subscription.id,
      purpose: 'distribution-payout-proof', status: 'ready' })
    if (existing >= 50) return send(res, 429, { error: 'PAYOUT_PROOF_LIMIT', message: '该员工打款凭证暂存数量已达上限' })
    const asset = await fileAssetService.uploadUnbound({ ...image, purpose: 'distribution-payout-proof',
      ownerType: 'subscription', ownerId: subscription.id, createdBy: actor.userId })
    return send(res, 201, { data: { id: asset.id, fileName: asset.originalName }, message: '打款凭证已保存' })
  }
  const paymentProofMatch = pathname.match(/^\/api\/projects\/([^/]+)\/procurement-payment\/proofs$/)
  if (paymentProofMatch) {
    const actor = financeOperator(req)
    const projectId = decodeURIComponent(paymentProofMatch[1])
    const project = await repositories.projects.getById(projectId)
    if (!project) return send(res, 404, { error: 'PROJECT_NOT_FOUND', message: '项目不存在' })
    if (await procurementPayments.findOne({ projectId })) return send(res, 409, { error: 'PROCUREMENT_PAYMENT_EXISTS', message: '该众筹单已登记采购付款' })
    const multipart = await readSingleImageMultipart(req, { maxFileBytes: 10 * 1024 * 1024,
      maxFieldBytes: 1024, allowedFields: [] })
    const image = validateImageFile({ ...multipart.file, maxBytes: 10 * 1024 * 1024,
      allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp'] })
    const existing = await repositories.fileAssets.count({ ownerType: 'project', ownerId: projectId,
      purpose: 'procurement-payment-proof', status: 'ready' })
    if (existing >= 5) return send(res, 429, { error: 'PAYMENT_PROOF_LIMIT', message: '每张众筹单最多上传 5 张采购付款凭证' })
    const asset = await fileAssetService.uploadUnbound({ ...image, purpose: 'procurement-payment-proof',
      ownerType: 'project', ownerId: projectId, createdBy: actor.userId })
    return send(res, 201, { data: { id: asset.id, fileName: asset.originalName }, message: '付款凭证已保存，待登记采购付款' })
  }
  const settlementOperator = pathname === '/api/invoices/ocr' || pathname === '/api/invoices/pending/delete'
    || /^\/api\/projects\/[^/]+\/settlements\/confirm$/.test(pathname)
    ? financeOperator(req) : undefined
  if (pathname === '/api/settlements/calc') {
    const context = requestContext(req)
    if (context.role !== 'finance' && context.role !== 'super_admin') throw new AppError(403, 'FORBIDDEN', '当前角色不能访问结算试算')
  }
  let manager: ReturnType<typeof managementActor> | undefined
  if (pathname === '/api/mcp/sync' || pathname === '/api/rules'
    || (pathname.startsWith('/api/rules/') && ['/update', '/status', '/delete'].some(suffix => pathname.endsWith(suffix)))) {
    manager = managementActor(req, ['admin'])
  } else if (pathname.startsWith('/api/projects/') && ['/open', '/terminate', '/interrupt'].some(suffix => pathname.endsWith(suffix))) {
    manager = managementActor(req, ['admin', 'super_admin'])
  } else if (pathname.startsWith('/api/takeovers/') && pathname.endsWith('/force')) {
    manager = managementActor(req, ['super_admin'])
  }
  if (pathname === '/api/receiving-codes' && String(req.headers['content-type'] ?? '').toLowerCase().startsWith('multipart/form-data;')) {
    const actor = receivingCodeManager(req)
    const { fields, image } = await readValidatedUpload(
      req,
      ['subject', 'accountNote', 'codeName', 'operator', 'createRequestId'],
      ['image/png', 'image/jpeg', 'image/webp']
    )
    const subject = fields.subject?.trim() ?? ''
    const accountNote = fields.accountNote?.trim() ?? ''
    const codeName = fields.codeName?.trim() ?? ''
    const createRequestId = fields.createRequestId?.trim() ?? ''
    if (!subject || !accountNote || !codeName) {
      return send(res, 400, { error: 'RECEIVING_CODE_FIELDS_REQUIRED', message: '请完整填写收款主体、账户说明和收款码名称' })
    }
    if (!createRequestId) {
      return send(res, 400, { error: 'RECEIVING_CODE_REQUEST_ID_REQUIRED', message: '缺少收款码创建请求标识，请重新打开创建窗口' })
    }
    const existing = await repositories.receivingCodes.findOne({ createRequestId } as never)
    if (!existing && await repositories.receivingCodes.count() >= maxReceivingCodes) {
      return send(res, 429, { error: 'RECEIVING_CODE_LIMIT_EXCEEDED', message: '收款码数量已达上限' })
    }
    const result = await createReceivingCodeOnce({
      createRequestId,
      subject,
      accountNote,
      codeName,
      operator: actor.label,
      role: actor.role,
      image
    }, {
      receivingCodes: repositories.receivingCodes,
      auditLogs: repositories.auditLogs,
      files: fileAssetService,
      mongo,
      idFactory: () => `RCV-${Date.now()}-${randomUUID().slice(0, 8)}`,
      auditIdFactory: () => `AUD-${Date.now()}-${randomUUID()}`,
      now
    })
    if (!receivingCodes.some(item => item.id === result.record.id)) receivingCodes.unshift(result.record as ReceivingCode)
    return send(res, result.created ? 201 : 200, {
      data: presentReceivingCode(result.record),
      message: result.created ? '收款码及图片已创建并保存' : '重复请求已返回原收款码'
    })
  }

  const multipartReceivingCodeImageMatch = pathname.match(/^\/api\/receiving-codes\/([^/]+)\/image$/)
  if (multipartReceivingCodeImageMatch) {
    const actor = receivingCodeManager(req)
    const receivingCodeId = decodeURIComponent(multipartReceivingCodeImageMatch[1])
    const current = await repositories.receivingCodes.getById(receivingCodeId)
    if (!current) return send(res, 404, { error: 'RECEIVING_CODE_NOT_FOUND', message: '项目收款码不存在' })
    await requireReceivingCodeMutable(receivingCodeId)
    const { image } = await readValidatedUpload(req, ['operator'], ['image/png', 'image/jpeg', 'image/webp'])
    const updated = await fileAssetService.replaceBinding({
      ...image,
      purpose: 'receiving-code',
      ownerType: 'receiving-code',
      ownerId: receivingCodeId,
      createdBy: actor.userId,
      previousAssetId: current.imageAssetId
    }, async (asset, session) => {
      const latest = await repositories.receivingCodes.getById(receivingCodeId, session)
      if (!latest) throw new Error('项目收款码不存在')
      await requireReceivingCodeMutable(receivingCodeId, session)
      const record = { ...latest, imageAssetId: asset.id, imageName: image.fileName, updatedBy: actor.label, updatedAt: now() }
      await repositories.receivingCodes.replace(record, session)
      await repositories.auditLogs.insert(auditRecord({
        actor: actor.label,
        role: actor.role,
        action: latest.imageAssetId ? '更换收款码图片' : '上传收款码图片',
        target: latest.id,
        before: { imageAssetId: latest.imageAssetId, imageName: latest.imageName },
        after: { imageAssetId: asset.id, imageName: image.fileName }
      }) as never, session)
      return record
    })
    const localIndex = receivingCodes.findIndex(item => item.id === receivingCodeId)
    if (localIndex >= 0) receivingCodes.splice(localIndex, 1, updated as ReceivingCode)
    return send(res, 200, { data: presentReceivingCode(updated), message: current.imageAssetId ? '收款码图片已更换并保存' : '收款码图片已上传并保存' })
  }

  if (pathname === '/api/payments/ocr') {
    if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('multipart/form-data;')) {
      return send(res, 415, { error: 'MULTIPART_REQUIRED', message: '请通过文件上传接口提交缴款凭证' })
    }
    const context = requestContext(req)
    const { fields, image } = await readValidatedUpload(
      req,
      ['paymentId', 'subscriptionId', 'expectedAmount', 'operator'],
      ['image/png', 'image/jpeg', 'image/bmp']
    )
    const subscriptionId = fields.subscriptionId?.trim()
    const current = subscriptionId ? await repositories.subscriptions.getById(subscriptionId) : null
    if (!current) return send(res, 404, { error: 'SUBSCRIPTION_NOT_FOUND', message: '认购记录不存在' })
    if ((await repositories.projects.getById(current.projectId))?.purchasePaymentId) return send(res, 409, { error: 'SUBSCRIPTION_LOCKED', message: '采购付款登记后认购单已锁定' })
    if (context.role !== 'employee' || current.userId !== context.userId) throw new AppError(403, 'FORBIDDEN', '只能上传本人认购的支付截图')
    if (['已缴款', '已收款', '已释放', '公司待出资', '待退款', '待确认退款', '已退款'].includes(current.pay)) return send(res, 409, { error: 'PAYMENT_NOT_UPLOADABLE', message: '该认购状态不允许上传支付截图' })
    if (current.shares !== undefined && Date.now() > new Date(current.paymentDeadlineAt.replace(' ', 'T')).getTime()) {
      return send(res, 409, { error: 'PAYMENT_DEADLINE_PASSED', message: '该认购的缴款期限已结束' })
    }
    if ((current.paymentImages?.length ?? 0) >= maxPaymentImagesPerSubscription) {
      return send(res, 429, { error: 'PAYMENT_IMAGE_LIMIT_EXCEEDED', message: `每条认购最多保留 ${maxPaymentImagesPerSubscription} 张支付截图` })
    }
    const actor = { userId: context.userId, label: `${context.userId} · 员工` }
    const asset = await fileAssetService.uploadUnbound({
      ...image,
      purpose: 'payment-proof',
      ownerType: 'subscription',
      ownerId: current.id,
      createdBy: actor.userId
    })
    let recognizedAmount = 0
    let recognitionFailure = ''
    try {
      ocrQuota.take('ocr')
      const recognized = await recognizeFinanceBill({
        imageDataUrl: ephemeralDataUrl(image),
        appCode: process.env.INVOICE_OCR_APPCODE ?? '',
        endpoint: process.env.INVOICE_OCR_API_URL
      })
      recognizedAmount = Number(recognized.amount ?? 0)
      if (!Number.isFinite(recognizedAmount) || recognizedAmount < 0.01) recognitionFailure = '未识别到有效交易金额'
    } catch (error) {
      recognitionFailure = error instanceof Error ? error.message : 'OCR 识别失败'
    }

    try {
      const updated = await mongo.withTransaction(async session => {
        const latest = await repositories.subscriptions.getById(current.id, session)
        if (!latest) throw new Error('认购记录不存在')
        if ((latest.paymentImages?.length ?? 0) >= maxPaymentImagesPerSubscription) throw new Error('支付截图数量已达上限')
        const uploadedAt = now()
        const imageRecord = {
          id: `PAYIMG-${Date.now()}-${randomUUID()}`,
          assetId: asset.id,
          paymentImageName: image.fileName,
          recognizedAmount: recognitionFailure ? 0 : Number(recognizedAmount.toFixed(2)),
          uploadedAt,
          status: recognitionFailure ? '识别失败' as const : '已识别' as const
        }
        const paymentImages = [...(latest.paymentImages ?? []), imageRecord]
        const recognizedTotal = Number(paymentImages.reduce((sum, item) => sum + (item.status === '已识别' ? item.recognizedAmount : 0), 0).toFixed(2))
        const expectedAmount = Number(latest.amount)
        const pay: PaymentStatus = latest.shares !== undefined
          ? '待复核'
          : recognitionFailure ? '待复核' : recognizedTotal === expectedAmount ? '已缴款' : recognizedTotal < expectedAmount ? '部分缴款' : '待复核'
        const record = {
          ...latest,
          paymentImages,
          paymentImageName: image.fileName,
          paymentUploadedAt: uploadedAt,
          paymentSuccessAt: recognitionFailure ? latest.paymentSuccessAt : uploadedAt,
          recognizedPaidAmount: recognizedTotal,
          pay,
          action: recognitionFailure || recognizedTotal < expectedAmount ? '重新上传截图' : '查看支付'
        }
        await repositories.subscriptions.replace(record, session)
        await repositories.auditLogs.insert(auditRecord({
          actor: actor.label,
          role: actor.userId === 'system' ? 'system' : 'employee',
          action: '上传支付截图并执行 OCR',
          target: fields.paymentId || current.id,
          before: { pay: latest.pay, imageCount: latest.paymentImages?.length ?? 0 },
          after: { pay, imageCount: paymentImages.length, recognizedTotal, assetId: asset.id }
        }) as never, session)
        return record
      })
      const localIndex = subscriptions.findIndex(item => item.id === updated.id)
      if (localIndex >= 0) subscriptions.splice(localIndex, 1, updated as Subscription)
      const remainingAmount = Math.max(0, Number((updated.amount - Number(updated.recognizedPaidAmount ?? 0)).toFixed(2)))
      return send(res, 200, {
        data: {
          status: updated.pay,
          ocr_status: recognitionFailure ? '待财务复核' : '已识别',
          recognized_total: updated.recognizedPaidAmount ?? 0,
          remaining_amount: remainingAmount,
          image_count: updated.paymentImages?.length ?? 0,
          reason: recognitionFailure || undefined
        },
        message: recognitionFailure ? '支付截图已保存，等待财务审核' : '支付截图 OCR 识别完成，等待财务审核'
      })
    } catch (error) {
      await fileAssetService.deleteBinding(asset.id, async () => undefined).catch(() => undefined)
      throw error
    }
  }

  if (pathname === '/api/invoices/ocr') {
    if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('multipart/form-data;')) {
      return send(res, 415, { error: 'MULTIPART_REQUIRED', message: '请通过文件上传接口提交发票凭证' })
    }
    const { fields, image } = await readValidatedUpload(req, ['projectId', 'fileName', 'operator'], ['image/png', 'image/jpeg', 'image/bmp'])
    const projectId = fields.projectId?.trim()
    const project = projectId ? await repositories.projects.getById(projectId) : null
    if (!project) return send(res, 404, { error: 'PROJECT_NOT_FOUND', message: '项目不存在' })
    if (!['已满额', '已截止', '待回款', '部分已结算'].includes(project.status)) {
      return send(res, 409, { error: 'PROJECT_NOT_SETTLEMENT_ELIGIBLE', message: '项目当前状态不允许发起结算识别' })
    }
    const asset = await fileAssetService.uploadUnbound({
      ...image,
      purpose: 'settlement-invoice',
      ownerType: 'project',
      ownerId: project.id,
      createdBy: settlementOperator!.userId
    })
    try {
      ocrQuota.take('ocr')
      const data = await recognizeFinanceBill({
        imageDataUrl: ephemeralDataUrl(image),
        appCode: process.env.INVOICE_OCR_APPCODE ?? '',
        endpoint: process.env.INVOICE_OCR_API_URL
      })
      const proof = ocrProofStore.create({
        projectId: project.id,
        assetId: asset.id,
        imageDigest: image.sha256,
        fileName: image.fileName,
        result: data
      })
      return send(res, 200, {
        data: { ...data, assetId: asset.id, fileName: image.fileName, settlementProofId: proof.proofId, proofExpiresAt: proof.expiresAt },
        message: '发票 OCR 识别完成'
      })
    } catch (error) {
      await fileAssetService.deleteBinding(asset.id, async () => undefined).catch(() => undefined)
      const message = error instanceof Error ? error.message : '发票识别失败'
      const status = error instanceof ResourceLimitError ? 429 : message.startsWith('未配置') ? 503 : 502
      return send(res, status, { error: 'INVOICE_OCR_FAILED', message })
    }
  }

  const body = await readJsonBody(req, DEFAULT_JSON_BODY_LIMIT)
  const projectRefundPaymentMatch = pathname.match(/^\/api\/project-refunds\/([^/]+)\/payment$/)
  if (projectRefundPaymentMatch) {
    const actor = financeOperator(req)
    const refundId = decodeURIComponent(projectRefundPaymentMatch[1])
    if (!Array.isArray(body.proofAssetIds) || body.proofAssetIds.some(id => typeof id !== 'string')) {
      return send(res, 400, { error: 'PROJECT_REFUND_PROOFS_INVALID', message: '请提供已上传的退款凭证编号' })
    }
    try {
      const result = await mongo.withTransaction(async session => {
        const refund = await projectRefunds.findOne({ id: refundId }, { session })
        if (!refund || refund.status !== '待退款') throw new AppError(409, 'PROJECT_REFUND_INVALID', '退款事项不存在或已登记')
        const project = await repositories.projects.getById(refund.projectId, session)
        const subscription = await repositories.subscriptions.getById(refund.subscriptionId, session)
        if (!project || project.status !== '关闭中' || !subscription || subscription.pay !== '待退款') {
          throw new AppError(409, 'PROJECT_REFUND_STATE_INVALID', '众筹单或认购单当前不可登记退款')
        }
        const payment = validateProjectRefundPayment({ amountCents: body.amountCents as number,
          transactionNo: typeof body.transactionNo === 'string' ? body.transactionNo : '',
          paidAt: body.paidAt as string, proofAssetIds: body.proofAssetIds as string[],
          manualVerificationNote: typeof body.manualVerificationNote === 'string' ? body.manualVerificationNote : '' },
        refund.amountCents, new Date())
        const occupied = await bankTransactions.findOne({ transactionNo: payment.transactionNo }, { session })
          || await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}fund_ledger`)
            .findOne({ transactionNo: payment.transactionNo }, { session })
        if (occupied) throw new AppError(409, 'BANK_TRANSACTION_DUPLICATE', '退款流水号已被使用')
        for (const assetId of payment.proofAssetIds) {
          const asset = await repositories.fileAssets.getById(assetId, session)
          if (!asset || asset.status !== 'ready' || asset.purpose !== 'subscription-refund-proof'
            || asset.ownerType !== 'subscription' || asset.ownerId !== refund.subscriptionId
            || asset.createdBy !== actor.userId
            || await projectRefunds.findOne({ proofAssetIds: assetId }, { session })) {
            throw new AppError(409, 'PROJECT_REFUND_PROOF_INVALID', '退款凭证不存在、未留存或已被使用')
          }
        }
        const updatedRefund: ProjectRefund = { ...refund, ...payment, status: '待员工确认', registeredBy: actor.userId }
        await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}projects`)
          .updateOne({ id: project.id, status: '关闭中' }, { $inc: { refundRevision: 1 } }, { session })
        const changed = await projectRefunds.replaceOne({ id: refund.id, status: '待退款' }, updatedRefund, { session })
        if (changed.modifiedCount !== 1) throw new AppError(409, 'PROJECT_REFUND_CHANGED', '退款事项已变化，请刷新后重试')
        const updatedSubscription: Subscription = { ...subscription, pay: '待确认退款', action: '确认退款到账' }
        await repositories.subscriptions.replace(updatedSubscription, session)
        await bankTransactions.insertOne({ transactionNo: payment.transactionNo,
          sourceKey: `project-refund:${refund.id}`, projectId: refund.projectId,
          createdAt: new Date().toISOString() }, { session })
        await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}fund_ledger`).insertOne({
          id: `LED-${randomUUID()}`, sourceKey: `project-refund:${refund.id}`,
          type: 'subscription_refund_sent', projectId: refund.projectId,
          subscriptionId: refund.subscriptionId, participantId: refund.participantId,
          amountCents: refund.amountCents, transactionNo: payment.transactionNo,
          transactionKey: `project-refund:${refund.id}`, proofAssetIds: payment.proofAssetIds,
          reviewedBy: actor.userId, createdAt: new Date().toISOString()
        }, { session })
        const audit = auditRecord({ actor: actor.label, role: 'finance', action: '登记员工认购款退款',
          target: refund.id, before: { status: refund.status },
          after: { status: updatedRefund.status, transactionNo: payment.transactionNo,
            amountCents: refund.amountCents } }) as AuditLog
        await repositories.auditLogs.insert(audit as never, session)
        return { updatedRefund, updatedSubscription, audit }
      })
      const index = subscriptions.findIndex(item => item.id === result.updatedSubscription.id)
      if (index >= 0) subscriptions.splice(index, 1, result.updatedSubscription)
      auditLogs.unshift(result.audit)
      return send(res, 200, { data: result.updatedRefund, message: '退款已登记，请等待员工确认' })
    } catch (error) {
      if (error instanceof AppError) return send(res, error.status, { error: error.code, message: error.message })
      if (isDuplicateKey(error)) return send(res, 409, { error: 'PROJECT_REFUND_DUPLICATE', message: '退款流水号或单据已存在' })
      if (error instanceof Error && /退款|流水号|凭证|时间|金额/.test(error.message)) {
        return send(res, 400, { error: 'PROJECT_REFUND_INVALID', message: error.message })
      }
      throw error
    }
  }
  const projectRefundConfirmMatch = pathname.match(/^\/api\/project-refunds\/([^/]+)\/confirm$/)
  if (projectRefundConfirmMatch) {
    const context = requestContext(req)
    if (context.role !== 'employee') throw new AppError(403, 'FORBIDDEN', '只有退款员工本人可以确认到账')
    const refundId = decodeURIComponent(projectRefundConfirmMatch[1])
    try {
      const result = await mongo.withTransaction(async session => {
        const refund = await projectRefunds.findOne({ id: refundId }, { session })
        if (!refund || refund.status !== '待员工确认') throw new AppError(409, 'PROJECT_REFUND_INVALID', '退款事项不存在或未待确认')
        if (refund.participantId !== context.userId) throw new AppError(403, 'FORBIDDEN', '只能确认本人退款')
        const subscription = await repositories.subscriptions.getById(refund.subscriptionId, session)
        const project = await repositories.projects.getById(refund.projectId, session)
        if (!subscription || subscription.pay !== '待确认退款' || !project || project.status !== '关闭中') {
          throw new AppError(409, 'PROJECT_REFUND_STATE_INVALID', '退款状态已变化')
        }
        const confirmedAt = new Date().toISOString()
        const updatedRefund: ProjectRefund = { ...refund, status: '已退款', confirmedAt }
        const changed = await projectRefunds.replaceOne({ id: refund.id, status: '待员工确认' }, updatedRefund, { session })
        if (changed.modifiedCount !== 1) throw new AppError(409, 'PROJECT_REFUND_CHANGED', '退款事项已变化')
        const updatedSubscription: Subscription = { ...subscription, pay: '已退款', action: '查看退款' }
        await repositories.subscriptions.replace(updatedSubscription, session)
        await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}projects`)
          .updateOne({ id: project.id }, { $inc: { refundRevision: 1 } }, { session })
        await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}fund_ledger`).insertOne({
          id: `LED-${randomUUID()}`, sourceKey: `project-refund-confirm:${refund.id}`,
          type: 'subscription_refund_confirmed', projectId: refund.projectId,
          subscriptionId: refund.subscriptionId, participantId: refund.participantId,
          amountCents: refund.amountCents, transactionNo: refund.transactionNo,
          transactionKey: `project-refund-confirm:${refund.id}`,
          proofAssetIds: refund.proofAssetIds ?? [], reviewedBy: context.userId, createdAt: confirmedAt
        }, { session })
        const pending = await projectRefunds.countDocuments({ projectId: project.id,
          status: { $ne: '已退款' }, id: { $ne: refund.id } }, { session })
        let closed = false
        if (pending === 0) {
          const contributions = await fundLedger.listProjectContributions(project.id, session)
          const outflow = await mongo.db.collection<{ projectId: string; type: string; amountCents: number }>(
            `${appConfig.mongodb.collectionPrefix}fund_ledger`)
            .find({ projectId: project.id, type: 'subscription_refund_confirmed' }, { session }).toArray()
          const incomingCents = contributions.reduce((sum, item) => sum + item.amountCents, 0)
          const refundedCents = outflow.reduce((sum, item) => sum + item.amountCents, 0)
          const exceptions = await exceptionFunds.countDocuments({ projectId: project.id, remainingCents: { $gt: 0 } }, { session })
          if (incomingCents === refundedCents && exceptions === 0) {
            await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}projects`)
              .updateOne({ id: project.id, status: '关闭中' }, { $set: { status: '已关闭', statusType: 'info',
                closedAt: confirmedAt, closedBy: context.userId } }, { session })
            closed = true
          }
        }
        const audit = auditRecord({ actor: context.userId, role: 'employee', action: '员工确认项目退款到账',
          target: refund.id, before: { status: refund.status },
          after: { status: updatedRefund.status, closed } }) as AuditLog
        await repositories.auditLogs.insert(audit as never, session)
        return { updatedRefund, updatedSubscription, audit, closed, projectId: project.id, confirmedAt }
      })
      const index = subscriptions.findIndex(item => item.id === result.updatedSubscription.id)
      if (index >= 0) subscriptions.splice(index, 1, result.updatedSubscription)
      if (result.closed) {
        const projectIndex = projects.findIndex(item => item.id === result.projectId)
        if (projectIndex >= 0) projects.splice(projectIndex, 1, {
          ...projects[projectIndex], status: '已关闭', statusType: 'info',
          closedAt: result.confirmedAt, closedBy: context.userId })
      }
      auditLogs.unshift(result.audit)
      return send(res, 200, { data: result.updatedRefund,
        message: result.closed ? '退款已确认，众筹单已关闭' : '退款已确认' })
    } catch (error) {
      if (error instanceof AppError) return send(res, error.status, { error: error.code, message: error.message })
      if (isDuplicateKey(error)) return send(res, 409, { error: 'PROJECT_REFUND_CONFIRMED', message: '退款已确认' })
      throw error
    }
  }
  const projectCloseMatch = pathname.match(/^\/api\/projects\/([^/]+)\/close$/)
  if (projectCloseMatch) {
    const actor = managementActor(req, ['admin'])
    const projectId = decodeURIComponent(projectCloseMatch[1])
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (reason.length < 5 || reason.length > 200) {
      return send(res, 400, { error: 'PROJECT_CLOSE_REASON_INVALID', message: '关闭原因须为 5 至 200 字' })
    }
    try {
      const result = await mongo.withTransaction(async session => {
        const project = await repositories.projects.getById(projectId, session)
        if (!project) throw new AppError(404, 'PROJECT_NOT_FOUND', '众筹单不存在')
        requireAdminOwned(req, project)
        if (!['未满额', '已满额', '已截止'].includes(project.status)
          || await procurementPayments.findOne({ projectId }, { session })) {
          throw new AppError(409, 'PROJECT_CLOSE_INVALID', '只有采购付款前的已发布众筹单可以关闭')
        }
        const records = await repositories.subscriptions.list({ projectId }, {}, session)
        if (records.some(record => record.pay === '待复核' || record.pay === '待确认收款')) {
          throw new AppError(409, 'PROJECT_CLOSE_PENDING_REVIEW', '仍有待复核款项，请先核对到账；无法匹配的款项须登记为异常款项')
        }
        const ledger = await fundLedger.listProjectContributions(projectId, session)
        const refundOrders: ProjectRefund[] = []
        const updatedRecords: Subscription[] = []
        for (const record of records) {
          const fundedCents = ledger.filter(entry => entry.subscriptionId === record.id)
            .reduce((sum, entry) => sum + entry.amountCents, 0)
          const expectedCents = Math.round(record.amount * 100)
          if (record.userId === 'company' && fundedCents > 0) {
            throw new AppError(409, 'COMPANY_FUNDING_UNRECONCILED', '公司出资已到账，请先核对，不可直接关闭')
          }
          if (record.userId !== 'company' && ((record.pay === '已缴款' && fundedCents !== expectedCents)
            || (record.pay === '部分缴款' && (fundedCents <= 0 || fundedCents > expectedCents
              || Math.round((record.actualPaidAmount ?? 0) * 100) !== fundedCents))
            || (!['已缴款', '部分缴款'].includes(record.pay) && fundedCents !== 0))) {
            throw new AppError(409, 'FUNDING_LEDGER_INCONSISTENT', '员工缴款与资金台账不一致，不能关闭')
          }
          if (record.userId !== 'company' && fundedCents > 0) {
            refundOrders.push({ id: `REF-${randomUUID()}`, projectId, subscriptionId: record.id,
              participantId: record.userId, amountCents: fundedCents, reason: '众筹关闭退款',
              status: '待退款', createdAt: new Date().toISOString() })
            updatedRecords.push({ ...record, pay: '待退款', action: '等待退款' })
          } else updatedRecords.push({ ...record, pay: '已释放', action: '认购已作废' })
        }
        const unresolvedExceptions = await exceptionFunds.countDocuments({ projectId, remainingCents: { $gt: 0 } }, { session })
        const status = refundOrders.length || unresolvedExceptions ? '关闭中' as const : '已关闭' as const
        const updatedProject = { ...project, status,
          statusType: status === '关闭中' ? 'warning' : 'info',
          interruptReason: reason, interruptedAt: new Date().toISOString(), refundNotice: undefined,
          ...(status === '已关闭' ? { closedAt: new Date().toISOString(), closedBy: actor.userId } : {}) } as Project
        await repositories.projects.replace(updatedProject, session)
        for (const record of updatedRecords) await repositories.subscriptions.replace(record, session)
        if (refundOrders.length) await projectRefunds.insertMany(refundOrders, { session })
        const audit = auditRecord({ actor: actor.label, role: actor.role, action: '发起众筹关闭',
          target: projectId, before: { status: project.status },
          after: { status, reason, refundCount: refundOrders.length,
            refundTotalCents: refundOrders.reduce((sum, item) => sum + item.amountCents, 0) } }) as AuditLog
        await repositories.auditLogs.insert(audit as never, session)
        return { updatedProject, updatedRecords, refundOrders, audit }
      })
      const projectIndex = projects.findIndex(item => item.id === projectId)
      if (projectIndex >= 0) projects.splice(projectIndex, 1, result.updatedProject)
      for (const record of result.updatedRecords) {
        const index = subscriptions.findIndex(item => item.id === record.id)
        if (index >= 0) subscriptions.splice(index, 1, record)
      }
      auditLogs.unshift(result.audit)
      return send(res, 200, { data: result.updatedProject,
        message: result.updatedProject.status === '关闭中'
          ? '已发起关闭，请财务核对退款和未处理异常款项' : '众筹单已关闭' })
    } catch (error) {
      if (error instanceof AppError) return send(res, error.status, { error: error.code, message: error.message })
      if (isDuplicateKey(error)) return send(res, 409, { error: 'PROJECT_CLOSE_DUPLICATE', message: '关闭退款事项已生成，请刷新' })
      throw error
    }
  }
  const projectReopenMatch = pathname.match(/^\/api\/projects\/([^/]+)\/reopen$/)
  if (projectReopenMatch) {
    const actor = managementActor(req, ['admin'])
    const sourceId = decodeURIComponent(projectReopenMatch[1])
    try {
      const result = await mongo.withTransaction(async session => {
        const original = await repositories.projects.getById(sourceId, session)
        if (!original) throw new AppError(404, 'PROJECT_NOT_FOUND', '原众筹单不存在')
        requireAdminOwned(req, original)
        if (original.status !== '已关闭' || original.reopenedByProjectId) {
          throw new AppError(409, 'PROJECT_REOPEN_INVALID', '仅已关闭且尚未重开的众筹单可以重开')
        }
        const originalRule = original.ruleId ? await repositories.rules.getById(original.ruleId, session) : null
        if (!originalRule) throw new AppError(409, 'PROJECT_REOPEN_RULE_MISSING', '原众筹单缺少发布规则快照，无法自动带入')
        if (!Number.isFinite(original.costAmount) || original.costAmount <= 0
          || !Number.isFinite(original.salesAmount) || original.salesAmount <= original.costAmount
          || !Number.isFinite(original.total) || original.total <= 0) {
          throw new AppError(409, 'PROJECT_REOPEN_AMOUNT_INVALID', '原众筹单采购和应收金额无效，请先核对')
        }
        if (original.offlineSalesOrder) {
          const active = await mongo.db.collection<Project>(`${appConfig.mongodb.collectionPrefix}projects`)
            .findOne({ offlineSalesOrder: original.offlineSalesOrder,
              status: { $nin: ['已关闭', '已中断', '已完结'] }, id: { $ne: original.id } }, { session })
          if (active) throw new AppError(409, 'PROCUREMENT_PROJECT_ACTIVE', '同一采购单已有未关闭的众筹单')
        }
        const identity = ownershipFrom(iamContextFor(req))
        const id = `PRJ-REOPEN-${randomUUID()}`
        const title = `${original.title}（重开）`
        const ruleId = `RULE-REOPEN-${randomUUID()}`
        const reopened: Project = {
          id, title, source: original.source, offlineSalesOrder: original.offlineSalesOrder,
          createdAt: new Date().toISOString(), projectOwner: actor.label, ...identity,
          reopenedFromProjectId: original.id, status: '未开放', statusType: 'info',
          progress: 0, remain: original.costAmount, deadline: original.deadline,
          total: original.total, costAmount: original.costAmount, salesAmount: original.salesAmount,
          profitAmount: original.profitAmount, companyFixedAmount: original.companyFixedAmount,
          companyTakeoverAmount: 0, companyForcedTakeoverAmount: 0,
          employeeSubscribedAmount: 0, subscribed: 0, people: 0, ruleId
        }
        const copiedRule: SubscriptionRule = { ...originalRule, id: ruleId, projectId: id,
          projectName: title, ...identity, status: '未启用', updatedAt: new Date().toISOString() }
        const changed = await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}projects`)
          .updateOne({ id: original.id, status: '已关闭', reopenedByProjectId: { $exists: false } },
            { $set: { reopenedByProjectId: id } }, { session })
        if (changed.modifiedCount !== 1) throw new AppError(409, 'PROJECT_REOPEN_CHANGED', '原众筹单已变化，请刷新')
        await repositories.projects.insert(reopened, session)
        await repositories.rules.insert(copiedRule, session)
        const audit = auditRecord({ actor: actor.label, role: actor.role, action: '重开已关闭众筹单',
          target: id, before: { sourceId: original.id, status: original.status },
          after: { projectId: id, status: reopened.status, copiedRuleId: ruleId } }) as AuditLog
        await repositories.auditLogs.insert(audit as never, session)
        return { reopened, copiedRule, audit }
      })
      projects.unshift(result.reopened)
      rules.unshift(result.copiedRule)
      const index = projects.findIndex(item => item.id === sourceId)
      if (index >= 0) projects.splice(index, 1, { ...projects[index], reopenedByProjectId: result.reopened.id })
      auditLogs.unshift(result.audit)
      return send(res, 201, { data: result.reopened,
        message: '重开草稿已创建，请更新规则日期、核对收款码并重新发布' })
    } catch (error) {
      if (error instanceof AppError) return send(res, error.status, { error: error.code, message: error.message })
      if (isDuplicateKey(error)) return send(res, 409, { error: 'PROJECT_REOPEN_DUPLICATE', message: '原众筹单已重开' })
      throw error
    }
  }
  const finishProjectCloseMatch = pathname.match(/^\/api\/projects\/([^/]+)\/finish-close$/)
  if (finishProjectCloseMatch) {
    const actor = financeOperator(req)
    const projectId = decodeURIComponent(finishProjectCloseMatch[1])
    try {
      const result = await mongo.withTransaction(async session => {
        const project = await repositories.projects.getById(projectId, session)
        if (!project || project.status !== '关闭中') throw new AppError(409, 'PROJECT_NOT_CLOSING', '众筹单当前不是关闭中')
        const pending = await projectRefunds.countDocuments({ projectId, status: { $ne: '已退款' } }, { session })
        if (pending > 0) throw new AppError(409, 'PROJECT_REFUNDS_PENDING', `仍有 ${pending} 笔员工退款待确认`)
        const contributions = await fundLedger.listProjectContributions(projectId, session)
        const outflow = await mongo.db.collection<{ amountCents: number }>(`${appConfig.mongodb.collectionPrefix}fund_ledger`)
          .find({ projectId, type: 'subscription_refund_confirmed' }, { session }).toArray()
        const incomingCents = contributions.reduce((sum, item) => sum + item.amountCents, 0)
        const refundedCents = outflow.reduce((sum, item) => sum + item.amountCents, 0)
        const exceptions = await exceptionFunds.countDocuments({ projectId, remainingCents: { $gt: 0 } }, { session })
        if (incomingCents !== refundedCents || exceptions > 0) {
          throw new AppError(409, 'PROJECT_CLOSE_RECONCILIATION_FAILED',
            `关闭前对账未通过：员工缴款与确认退款差额 ${((incomingCents - refundedCents) / 100).toFixed(2)} 元，未处理异常款项 ${exceptions} 笔`)
        }
        const closedAt = new Date().toISOString()
        const changed = await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}projects`)
          .updateOne({ id: projectId, status: '关闭中' }, { $set: { status: '已关闭',
            statusType: 'info', closedAt, closedBy: actor.userId } }, { session })
        if (changed.modifiedCount !== 1) throw new AppError(409, 'PROJECT_CHANGED', '众筹单状态已变化')
        const audit = auditRecord({ actor: actor.label, role: 'finance', action: '完成众筹关闭',
          target: projectId, before: { status: project.status },
          after: { status: '已关闭', incomingCents, refundedCents, exceptions } }) as AuditLog
        await repositories.auditLogs.insert(audit as never, session)
        return { audit, closedAt }
      })
      const index = projects.findIndex(item => item.id === projectId)
      if (index >= 0) projects.splice(index, 1, { ...projects[index], status: '已关闭',
        statusType: 'info', closedAt: result.closedAt, closedBy: actor.userId })
      auditLogs.unshift(result.audit)
      return send(res, 200, { data: { projectId, status: '已关闭', closedAt: result.closedAt }, message: '众筹单已关闭' })
    } catch (error) {
      if (error instanceof AppError) return send(res, error.status, { error: error.code, message: error.message })
      throw error
    }
  }
  const closeOrderMatch = pathname.match(/^\/api\/distribution-orders\/([^/]+)\/close$/)
  if (closeOrderMatch) {
    const actor = financeOperator(req)
    const orderId = decodeURIComponent(closeOrderMatch[1])
    try {
      const result = await mongo.withTransaction(async session => {
        const order = await distributionOrders.findOne({ id: orderId }, { session })
        if (!order || order.status !== '可结单') throw new AppError(409, 'DISTRIBUTION_NOT_CLOSE_READY', '分配单尚未完成全部收款确认')
        const project = await repositories.projects.getById(order.projectId, session)
        if (!project || project.status !== '分配中') throw new AppError(409, 'PROJECT_NOT_CLOSE_READY', '众筹单当前不能结单')
        const lock = await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}projects`)
          .updateOne({ id: project.id, status: '分配中' }, { $inc: { closeRevision: 1 } }, { session })
        if (lock.modifiedCount !== 1) throw new AppError(409, 'PROJECT_CHANGED', '众筹单状态已变化，请刷新后重试')
        const snapshot = await financialReconciliationSnapshot(project.id, session)
        if (!snapshot.data.closeReady || snapshot.order?.id !== order.id) {
          throw new AppError(409, 'FINANCIAL_RECONCILIATION_FAILED',
            `结单前对账未通过：分配差额 ${(snapshot.data.distributionDifferenceCents / 100).toFixed(2)} 元，打款差额 ${(snapshot.data.payoutDifferenceCents / 100).toFixed(2)} 元，异常款项待处理 ${(snapshot.data.unprocessedExceptionCents / 100).toFixed(2)} 元`)
        }
        const closedAt = new Date().toISOString()
        const completed: DistributionOrder = { ...order, status: '已完成', closedAt, closedBy: actor.userId }
        const changed = await distributionOrders.replaceOne({ id: order.id, status: '可结单' }, completed, { session })
        if (changed.modifiedCount !== 1) throw new AppError(409, 'DISTRIBUTION_CHANGED', '分配单状态已变化，请刷新后重试')
        await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}projects`).updateOne({ id: project.id },
          { $set: { status: '已完结', statusType: 'success', closedAt, closedBy: actor.userId } }, { session })
        const audit = auditRecord({ actor: actor.label, role: 'finance', action: '结单', target: project.id,
          before: { projectStatus: project.status, distributionStatus: order.status },
          after: { projectStatus: '已完结', distributionStatus: '已完成', checkedAt: snapshot.data.checkedAt,
            closeReady: snapshot.data.closeReady } }) as AuditLog
        await repositories.auditLogs.insert(audit as never, session)
        return { completed, audit, projectId: project.id, closedAt }
      })
      const projectIndex = projects.findIndex(item => item.id === result.projectId)
      if (projectIndex >= 0) projects.splice(projectIndex, 1, {
        ...projects[projectIndex], status: '已完结', statusType: 'success',
        closedAt: result.closedAt, closedBy: actor.userId })
      auditLogs.unshift(result.audit)
      return send(res, 200, { data: result.completed, message: '结单成功' })
    } catch (error) {
      if (error instanceof AppError) return send(res, error.status, { error: error.code, message: error.message })
      throw error
    }
  }
  if (pathname === '/api/exception-funds') {
    const actor = financeOperator(req)
    const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : ''
    if (!Array.isArray(body.proofAssetIds) || body.proofAssetIds.some(id => typeof id !== 'string')) {
      return send(res, 400, { error: 'EXCEPTION_PROOFS_INVALID', message: '请提供已上传的异常款项凭证编号' })
    }
    try {
      const result = await mongo.withTransaction(async session => {
        if (projectId) {
          const project = await repositories.projects.getById(projectId, session)
          if (!project || project.status === '已完结') throw new AppError(409, 'EXCEPTION_PROJECT_INVALID', '所属众筹单不存在或已结单')
          await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}projects`)
            .updateOne({ id: projectId, status: { $ne: '已完结' } },
              { $inc: { exceptionRevision: 1 } }, { session })
        }
        const record = validateExceptionFund({ id: `EXF-${randomUUID()}`,
          ...(projectId ? { projectId } : {}), amountCents: body.amountCents as number,
          ...(typeof body.payerUserId === 'string' && body.payerUserId.trim()
            ? { payerUserId: body.payerUserId.trim() } : {}),
          transactionNo: typeof body.transactionNo === 'string' ? body.transactionNo : '',
          bookedAt: body.bookedAt as string,
          sourceNote: typeof body.sourceNote === 'string' ? body.sourceNote : '',
          manualVerificationNote: typeof body.manualVerificationNote === 'string' ? body.manualVerificationNote : '',
          proofAssetIds: body.proofAssetIds as string[], registeredBy: actor.userId }, new Date())
        const occupied = await bankTransactions.findOne({ transactionNo: record.transactionNo }, { session })
          || await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}fund_ledger`)
            .findOne({ transactionNo: record.transactionNo }, { session })
        if (occupied) throw new AppError(409, 'BANK_TRANSACTION_DUPLICATE', `流水号【${record.transactionNo}】已被使用，请核对`)
        for (const assetId of record.proofAssetIds) {
          const asset = await repositories.fileAssets.getById(assetId, session)
          if (!asset || asset.status !== 'ready' || asset.purpose !== 'exception-fund-proof'
            || asset.ownerType !== 'project' || asset.ownerId !== `exception-staging:${actor.userId}`
            || asset.createdBy !== actor.userId
            || await exceptionFunds.findOne({ proofAssetIds: assetId }, { session })) {
            throw new AppError(409, 'EXCEPTION_PROOF_INVALID', '异常款项凭证不存在、未留存或已被使用')
          }
        }
        await bankTransactions.insertOne({ transactionNo: record.transactionNo,
          sourceKey: `exception-fund:${record.id}`, projectId, createdAt: record.createdAt }, { session })
        await exceptionFunds.insertOne(record, { session })
        await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}fund_ledger`).insertOne({
          id: `LED-${randomUUID()}`, sourceKey: `exception-fund:${record.id}`,
          type: 'exception_fund_received', projectId, amountCents: record.amountCents,
          transactionNo: record.transactionNo, transactionKey: `exception-fund:${record.id}`,
          proofAssetIds: record.proofAssetIds, reviewedBy: actor.userId, createdAt: record.createdAt
        }, { session })
        const audit = auditRecord({ actor: actor.label, role: 'finance', action: '登记异常款项',
          target: record.id, before: null, after: { projectId, amountCents: record.amountCents,
            transactionNo: record.transactionNo } }) as AuditLog
        await repositories.auditLogs.insert(audit as never, session)
        return { record, audit }
      })
      auditLogs.unshift(result.audit)
      return send(res, 201, { data: result.record, message: '异常款项登记成功' })
    } catch (error) {
      if (error instanceof AppError) return send(res, error.status, { error: error.code, message: error.message })
      if (isDuplicateKey(error)) return send(res, 409, { error: 'EXCEPTION_DUPLICATE', message: '异常款项流水号或单据已存在' })
      if (error instanceof Error && /异常款项|金额|流水号|凭证|到账时间|识别/.test(error.message)) {
        return send(res, 400, { error: 'EXCEPTION_INVALID', message: error.message })
      }
      throw error
    }
  }
  const exceptionRefundMatch = pathname.match(/^\/api\/exception-funds\/([^/]+)\/refunds$/)
  if (exceptionRefundMatch) {
    const actor = financeOperator(req)
    const fundId = decodeURIComponent(exceptionRefundMatch[1])
    if (!Array.isArray(body.proofAssetIds) || body.proofAssetIds.some(id => typeof id !== 'string')) {
      return send(res, 400, { error: 'EXCEPTION_REFUND_PROOFS_INVALID', message: '请提供已上传的退回凭证编号' })
    }
    try {
      const result = await mongo.withTransaction(async session => {
        const current = await exceptionFunds.findOne({ id: fundId }, { session })
        if (!current) throw new AppError(404, 'EXCEPTION_FUND_NOT_FOUND', '异常款项不存在')
        if (current.projectId) {
          const project = await repositories.projects.getById(current.projectId, session)
          if (!project || project.status === '已完结') throw new AppError(409, 'EXCEPTION_PROJECT_CLOSED', '众筹单已结单')
          await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}projects`)
            .updateOne({ id: current.projectId }, { $inc: { exceptionRevision: 1 } }, { session })
        }
        const updated = reserveExceptionRefund(current, { id: `EXR-${randomUUID()}`,
          amountCents: body.amountCents as number,
          transactionNo: typeof body.transactionNo === 'string' ? body.transactionNo : '',
          paidAt: body.paidAt as string, reason: typeof body.reason === 'string' ? body.reason : '',
          proofAssetIds: body.proofAssetIds as string[], registeredBy: actor.userId }, new Date())
        const allocation = updated.allocations.at(-1)!
        const occupied = await bankTransactions.findOne({ transactionNo: allocation.transactionNo }, { session })
          || await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}fund_ledger`)
            .findOne({ transactionNo: allocation.transactionNo }, { session })
        if (occupied) throw new AppError(409, 'BANK_TRANSACTION_DUPLICATE', `流水号【${allocation.transactionNo}】已被使用，请核对`)
        for (const assetId of allocation.proofAssetIds ?? []) {
          const asset = await repositories.fileAssets.getById(assetId, session)
          if (!asset || asset.status !== 'ready' || asset.purpose !== 'exception-refund-proof'
            || asset.ownerType !== 'project' || asset.ownerId !== `exception-refund-staging:${fundId}:${actor.userId}`
            || asset.createdBy !== actor.userId
            || await exceptionFunds.findOne({ 'allocations.proofAssetIds': assetId }, { session })) {
            throw new AppError(409, 'EXCEPTION_REFUND_PROOF_INVALID', '退回凭证不存在、未留存或已被使用')
          }
        }
        const changed = await exceptionFunds.replaceOne({ id: fundId, revision: current.revision }, updated, { session })
        if (changed.modifiedCount !== 1) throw new AppError(409, 'EXCEPTION_FUND_CHANGED', '异常款项已变化，请刷新后重试')
        await bankTransactions.insertOne({ transactionNo: allocation.transactionNo!,
          sourceKey: `exception-refund:${allocation.id}`, projectId: current.projectId ?? '',
          createdAt: allocation.createdAt }, { session })
        await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}fund_ledger`).insertOne({
          id: `LED-${randomUUID()}`, sourceKey: `exception-refund:${allocation.id}`,
          type: 'exception_fund_refund_sent', projectId: current.projectId ?? '',
          amountCents: allocation.amountCents, transactionNo: allocation.transactionNo,
          transactionKey: `exception-refund:${allocation.id}`, proofAssetIds: allocation.proofAssetIds,
          reviewedBy: actor.userId, createdAt: allocation.createdAt
        }, { session })
        const audit = auditRecord({ actor: actor.label, role: 'finance', action: '登记异常款项退回',
          target: fundId, before: { remainingCents: current.remainingCents },
          after: { allocationId: allocation.id, amountCents: allocation.amountCents,
            transactionNo: allocation.transactionNo, recipientKind: allocation.recipientKind } }) as AuditLog
        await repositories.auditLogs.insert(audit as never, session)
        return { allocation, audit }
      })
      auditLogs.unshift(result.audit)
      return send(res, 201, { data: result.allocation, message: '退回已登记，等待收款确认' })
    } catch (error) {
      if (error instanceof AppError) return send(res, error.status, { error: error.code, message: error.message })
      if (isDuplicateKey(error)) return send(res, 409, { error: 'EXCEPTION_REFUND_DUPLICATE', message: '退回流水号已被使用' })
      if (error instanceof Error && /退回|金额|流水号|凭证|时间/.test(error.message)) {
        return send(res, 400, { error: 'EXCEPTION_REFUND_INVALID', message: error.message })
      }
      throw error
    }
  }
  const exceptionAssignMatch = pathname.match(/^\/api\/exception-funds\/([^/]+)\/assign-project$/)
  if (exceptionAssignMatch) {
    const actor = financeOperator(req)
    const fundId = decodeURIComponent(exceptionAssignMatch[1])
    const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : ''
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (reason.length < 5 || reason.length > 200) {
      return send(res, 400, { error: 'EXCEPTION_ASSIGN_REASON_INVALID', message: '归属核实说明须为 5 至 200 字' })
    }
    try {
      const result = await mongo.withTransaction(async session => {
        const current = await exceptionFunds.findOne({ id: fundId }, { session })
        if (!current || current.projectId || current.allocations.length > 0) {
          throw new AppError(409, 'EXCEPTION_ASSIGN_INVALID', '款项不存在、已归属或已有处理记录')
        }
        const project = await repositories.projects.getById(projectId, session)
        if (!project || project.status === '已完结') throw new AppError(409, 'EXCEPTION_PROJECT_INVALID', '目标众筹单不存在或已结单')
        await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}projects`)
          .updateOne({ id: projectId, status: { $ne: '已完结' } },
            { $inc: { exceptionRevision: 1 } }, { session })
        const updated: ExceptionFund = { ...current, projectId, revision: current.revision + 1 }
        const changed = await exceptionFunds.replaceOne({ id: fundId, revision: current.revision,
          projectId: { $exists: false } }, updated, { session })
        if (changed.modifiedCount !== 1) throw new AppError(409, 'EXCEPTION_FUND_CHANGED', '款项归属已变化，请刷新后重试')
        await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}fund_ledger`).insertOne({
          id: `LED-${randomUUID()}`, sourceKey: `exception-attribution:${fundId}`,
          type: 'exception_fund_attributed', projectId, amountCents: current.amountCents,
          transactionKey: `exception-attribution:${fundId}`, proofAssetIds: current.proofAssetIds,
          reviewedBy: actor.userId, createdAt: new Date().toISOString()
        }, { session })
        const audit = auditRecord({ actor: actor.label, role: 'finance', action: '核实异常款项所属众筹单',
          target: fundId, before: { projectId: null }, after: { projectId, reason } }) as AuditLog
        await repositories.auditLogs.insert(audit as never, session)
        return { updated, audit }
      })
      auditLogs.unshift(result.audit)
      return send(res, 200, { data: result.updated, message: '众筹单归属已核实' })
    } catch (error) {
      if (error instanceof AppError) return send(res, error.status, { error: error.code, message: error.message })
      if (isDuplicateKey(error)) return send(res, 409, { error: 'EXCEPTION_ASSIGN_DUPLICATE', message: '款项归属已记录' })
      throw error
    }
  }
  const exceptionRefundConfirmMatch = pathname.match(/^\/api\/exception-funds\/([^/]+)\/refunds\/([^/]+)\/confirm$/)
  if (exceptionRefundConfirmMatch) {
    const context = requestContext(req)
    const fundId = decodeURIComponent(exceptionRefundConfirmMatch[1])
    const allocationId = decodeURIComponent(exceptionRefundConfirmMatch[2])
    try {
      const result = await mongo.withTransaction(async session => {
        const current = await exceptionFunds.findOne({ id: fundId }, { session })
        if (!current) throw new AppError(404, 'EXCEPTION_FUND_NOT_FOUND', '异常款项不存在')
        if (current.projectId) {
          await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}projects`)
            .updateOne({ id: current.projectId }, { $inc: { exceptionRevision: 1 } }, { session })
        }
        const allocation = current.allocations.find(item => item.id === allocationId)
        if (!allocation || allocation.status !== '待确认' || allocation.kind !== '退回') {
          throw new AppError(409, 'EXCEPTION_REFUND_INVALID', '退回单不存在或已确认')
        }
        if (allocation.recipientKind === 'employee' && (context.role !== 'employee'
          || allocation.recipientUserId !== context.userId)) {
          throw new AppError(403, 'FORBIDDEN', '仅付款员工本人可以确认该笔退回')
        }
        if (allocation.recipientKind === 'external' && context.role !== 'super_admin') {
          throw new AppError(403, 'FORBIDDEN', '非员工退回须由公司复核')
        }
        const updated = confirmExceptionRefund(current, allocationId, context.userId, new Date())
        const changed = await exceptionFunds.replaceOne({ id: fundId, revision: current.revision }, updated, { session })
        if (changed.modifiedCount !== 1) throw new AppError(409, 'EXCEPTION_FUND_CHANGED', '异常款项已变化，请刷新后重试')
        await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}fund_ledger`).insertOne({
          id: `LED-${randomUUID()}`, sourceKey: `exception-refund-confirm:${allocationId}`,
          type: 'exception_fund_refund_confirmed', projectId: current.projectId ?? '',
          amountCents: allocation.amountCents, transactionNo: allocation.transactionNo,
          transactionKey: `exception-refund-confirm:${allocationId}`,
          proofAssetIds: allocation.proofAssetIds ?? [], reviewedBy: context.userId,
          createdAt: new Date().toISOString()
        }, { session })
        const audit = auditRecord({ actor: context.userId, role: context.role,
          action: '确认异常款项退回到账', target: fundId,
          before: { remainingCents: current.remainingCents },
          after: { allocationId, remainingCents: updated.remainingCents } }) as AuditLog
        await repositories.auditLogs.insert(audit as never, session)
        return { updated, audit }
      })
      auditLogs.unshift(result.audit)
      return send(res, 200, { data: result.updated, message: '退回确认完成' })
    } catch (error) {
      if (error instanceof AppError) return send(res, error.status, { error: error.code, message: error.message })
      if (isDuplicateKey(error)) return send(res, 409, { error: 'EXCEPTION_REFUND_CONFIRMED', message: '该笔退回已确认' })
      throw error
    }
  }
  const exceptionTransferMatch = pathname.match(/^\/api\/exception-funds\/([^/]+)\/transfers$/)
  if (exceptionTransferMatch) {
    const actor = financeOperator(req)
    const fundId = decodeURIComponent(exceptionTransferMatch[1])
    const subscriptionId = typeof body.subscriptionId === 'string' ? body.subscriptionId.trim() : ''
    try {
      const result = await mongo.withTransaction(async session => {
        const current = await exceptionFunds.findOne({ id: fundId }, { session })
        if (!current || !current.projectId) throw new AppError(409, 'EXCEPTION_FUND_UNATTRIBUTED', '异常款项不存在或尚未核实所属众筹单')
        const subscription = await repositories.subscriptions.getById(subscriptionId, session)
        if (!subscription || subscription.projectId !== current.projectId || subscription.userId === 'company'
          || !['未缴款', '部分缴款'].includes(subscription.pay) || !subscription.shares) {
          throw new AppError(409, 'EXCEPTION_SUBSCRIPTION_INVALID', '认购单不存在或当前不可转入')
        }
        const deadline = Date.parse(subscription.paymentDeadlineAt.replace(' ', 'T'))
        if (!Number.isFinite(deadline) || Date.now() > deadline || Date.parse(current.bookedAt) > deadline) {
          throw new AppError(409, 'EXCEPTION_SUBSCRIPTION_EXPIRED', '该认购单已过缴款截止时间，不可转入')
        }
        if (await procurementPayments.findOne({ projectId: current.projectId }, { session })) {
          throw new AppError(409, 'EXCEPTION_SUBSCRIPTION_LOCKED', '采购付款后不可再转入认购单')
        }
        const existingContributions = await fundLedger.listProjectContributions(current.projectId, session)
        const fundedCents = existingContributions.filter(entry => entry.subscriptionId === subscriptionId)
          .reduce((sum, entry) => sum + entry.amountCents, 0)
        if (subscription.pay === '部分缴款' && Math.round((subscription.actualPaidAmount ?? 0) * 100) !== fundedCents) {
          throw new AppError(409, 'PARTIAL_PAYMENT_UNRECONCILED', '该部分缴款尚未与资金台账核对，暂不能转入')
        }
        const pending = await exceptionFunds.find({ allocations: { $elemMatch: {
          subscriptionId, kind: '转入认购单', status: '待确认' } } }, { session }).toArray()
        const reservedCents = pending.flatMap(fund => fund.allocations)
          .filter(item => item.subscriptionId === subscriptionId && item.kind === '转入认购单' && item.status === '待确认')
          .reduce((sum, item) => sum + item.amountCents, 0)
        const unpaidCents = Math.round(subscription.amount * 100) - fundedCents - reservedCents
        if (!Number.isSafeInteger(body.amountCents) || Number(body.amountCents) <= 0
          || Number(body.amountCents) > unpaidCents) {
          throw new AppError(400, 'EXCEPTION_TRANSFER_AMOUNT_INVALID',
            `转入金额超出可转入范围，最多可转入 ${(Math.max(0, unpaidCents) / 100).toFixed(2)} 元`)
        }
        const updated = reserveExceptionTransfer(current, { id: `EXT-${randomUUID()}`, subscriptionId,
          amountCents: body.amountCents as number, reason: typeof body.reason === 'string' ? body.reason : '' }, new Date())
        await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}projects`)
          .updateOne({ id: current.projectId }, { $inc: { fundingRevision: 1 } }, { session })
        const changed = await exceptionFunds.replaceOne({ id: fundId, revision: current.revision }, updated, { session })
        if (changed.modifiedCount !== 1) throw new AppError(409, 'EXCEPTION_FUND_CHANGED', '异常款项已变化，请刷新后重试')
        const allocation = updated.allocations.at(-1)!
        const audit = auditRecord({ actor: actor.label, role: 'finance', action: '异常款项申请转入认购单',
          target: fundId, before: { remainingCents: current.remainingCents },
          after: { allocationId: allocation.id, subscriptionId, amountCents: allocation.amountCents } }) as AuditLog
        await repositories.auditLogs.insert(audit as never, session)
        return { allocation, audit }
      })
      auditLogs.unshift(result.audit)
      return send(res, 201, { data: result.allocation, message: '转入已提交公司复核' })
    } catch (error) {
      if (error instanceof AppError) return send(res, error.status, { error: error.code, message: error.message })
      if (error instanceof RangeError || error instanceof Error && /转入|认购单/.test(error.message)) {
        return send(res, 400, { error: 'EXCEPTION_TRANSFER_INVALID', message: error.message })
      }
      throw error
    }
  }
  const exceptionTransferReviewMatch = pathname.match(/^\/api\/exception-funds\/([^/]+)\/transfers\/([^/]+)\/review$/)
  if (exceptionTransferReviewMatch) {
    const actor = managementActor(req, ['super_admin'])
    const fundId = decodeURIComponent(exceptionTransferReviewMatch[1])
    const allocationId = decodeURIComponent(exceptionTransferReviewMatch[2])
    const decision = body.decision === '通过' || body.decision === '驳回' ? body.decision : undefined
    if (!decision) return send(res, 400, { error: 'EXCEPTION_TRANSFER_DECISION_INVALID', message: '请选择通过或驳回' })
    try {
      const result = await mongo.withTransaction(async session => {
        const current = await exceptionFunds.findOne({ id: fundId }, { session })
        const allocation = current?.allocations.find(item => item.id === allocationId)
        if (!current || !allocation || allocation.kind !== '转入认购单' || allocation.status !== '待确认'
          || !current.projectId || !allocation.subscriptionId) {
          throw new AppError(409, 'EXCEPTION_TRANSFER_INVALID', '转入单不存在或已复核')
        }
        if (decision === '通过' && actor.userId === current.registeredBy) {
          throw new AppError(403, 'SELF_REVIEW_FORBIDDEN', '登记人不得复核本人登记的异常款项')
        }
        let updatedSubscription: Subscription | undefined
        if (decision === '通过') {
          const subscription = await repositories.subscriptions.getById(allocation.subscriptionId, session)
          if (!subscription || subscription.projectId !== current.projectId || subscription.userId === 'company'
            || !['未缴款', '部分缴款'].includes(subscription.pay)) {
            throw new AppError(409, 'EXCEPTION_SUBSCRIPTION_INVALID', '认购单状态已变化，不可转入')
          }
          const deadline = Date.parse(subscription.paymentDeadlineAt.replace(' ', 'T'))
          if (!Number.isFinite(deadline) || Date.now() > deadline || Date.parse(current.bookedAt) > deadline) {
            throw new AppError(409, 'EXCEPTION_SUBSCRIPTION_EXPIRED', '该认购单已过缴款截止时间，不可转入')
          }
          if (await procurementPayments.findOne({ projectId: current.projectId }, { session })) {
            throw new AppError(409, 'EXCEPTION_SUBSCRIPTION_LOCKED', '采购付款后不可再转入认购单')
          }
          const contributions = await fundLedger.listProjectContributions(current.projectId, session)
          const fundedCents = contributions.filter(entry => entry.subscriptionId === subscription.id)
            .reduce((sum, entry) => sum + entry.amountCents, 0)
          const paidCents = fundedCents + allocation.amountCents
          const expectedCents = Math.round(subscription.amount * 100)
          if (paidCents > expectedCents) throw new AppError(409, 'EXCEPTION_TRANSFER_EXCESS', '转入后将超过认购应缴金额')
          updatedSubscription = { ...subscription, pay: paidCents === expectedCents ? '已缴款' : '部分缴款',
            actualPaidAmount: paidCents / 100, reviewedBy: actor.userId, reviewedAt: new Date().toISOString(),
            action: '查看支付' }
          await repositories.subscriptions.replace(updatedSubscription, session)
          await fundLedger.append({ id: `LED-${randomUUID()}`, sourceKey: `exception-transfer:${allocationId}`,
            type: 'employee_contribution', projectId: current.projectId,
            subscriptionId: subscription.id, participantId: subscription.userId,
            shares: paidCents === expectedCents ? subscription.shares ?? 0 : 0,
            amountCents: allocation.amountCents, transactionNo: current.transactionNo,
            transactionKey: `exception-transfer:${allocationId}`, proofAssetIds: current.proofAssetIds,
            reviewedBy: actor.userId, createdAt: new Date().toISOString() }, session)
          await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}projects`)
            .updateOne({ id: current.projectId }, { $inc: { fundingRevision: 1 } }, { session })
        }
        const updated = reviewExceptionTransfer(current, allocationId, decision, actor.userId, new Date())
        const changed = await exceptionFunds.replaceOne({ id: fundId, revision: current.revision }, updated, { session })
        if (changed.modifiedCount !== 1) throw new AppError(409, 'EXCEPTION_FUND_CHANGED', '异常款项已变化，请刷新后重试')
        const audit = auditRecord({ actor: actor.label, role: actor.role,
          action: decision === '通过' ? '公司复核异常款项转入通过' : '公司驳回异常款项转入',
          target: fundId, before: { remainingCents: current.remainingCents },
          after: { allocationId, remainingCents: updated.remainingCents, subscriptionId: allocation.subscriptionId } }) as AuditLog
        await repositories.auditLogs.insert(audit as never, session)
        return { updated, updatedSubscription, audit }
      })
      if (result.updatedSubscription) {
        const index = subscriptions.findIndex(item => item.id === result.updatedSubscription!.id)
        if (index >= 0) subscriptions.splice(index, 1, result.updatedSubscription)
      }
      auditLogs.unshift(result.audit)
      return send(res, 200, { data: result.updated, message: decision === '通过' ? '转入认购单复核通过' : '转入申请已驳回' })
    } catch (error) {
      if (error instanceof AppError) return send(res, error.status, { error: error.code, message: error.message })
      if (isDuplicateKey(error)) return send(res, 409, { error: 'EXCEPTION_TRANSFER_DUPLICATE', message: '该转入已处理' })
      throw error
    }
  }
  const payoutMatch = pathname.match(/^\/api\/distribution-orders\/([^/]+)\/lines\/([^/]+)\/payout$/)
  if (payoutMatch) {
    const actor = financeOperator(req)
    const orderId = decodeURIComponent(payoutMatch[1])
    const participantId = decodeURIComponent(payoutMatch[2])
    try {
      const result = await mongo.withTransaction(async session => {
        const order = await distributionOrders.findOne({ id: orderId }, { session })
        const index = order?.lines.findIndex(line => line.participantId === participantId) ?? -1
        if (!order || index < 0 || !['已审批', '打款登记中'].includes(order.status)
          || order.lines[index].status !== '待登记打款') {
          throw new AppError(409, 'PAYOUT_LINE_INVALID', '该分配明细当前不能登记打款')
        }
        const project = await repositories.projects.getById(order.projectId, session)
        if (!project || project.status !== '分配中') throw new AppError(409, 'PAYOUT_PROJECT_INVALID', '众筹单当前不允许登记打款')
        const line = order.lines[index]
        if (!Number.isSafeInteger(body.amountCents) || body.amountCents !== line.payoutCents) {
          throw new AppError(400, 'PAYOUT_AMOUNT_INVALID', '打款金额须等于分配金额')
        }
        const paidAt = Date.parse(body.paidAt as string)
        if (!Number.isFinite(paidAt) || paidAt > Date.now()) throw new AppError(400, 'PAYOUT_TIME_INVALID', '打款时间不得晚于当前时间')
        let transactionNo: string | undefined
        let proofAssetIds: string[] = []
        let note: string | undefined
        if (line.kind === 'company') {
          if (body.companyTransferConfirmed !== true) throw new AppError(400, 'COMPANY_TRANSFER_UNCONFIRMED', '请确认公司内部结转金额')
        } else {
          transactionNo = typeof body.transactionNo === 'string' ? body.transactionNo.trim() : ''
          if (transactionNo.length < 6 || transactionNo.length > 64) throw new AppError(400, 'PAYOUT_TRANSACTION_INVALID', '打款流水号须为 6 至 64 字')
          if (!Array.isArray(body.proofAssetIds) || body.proofAssetIds.length < 1 || body.proofAssetIds.length > 5
            || body.proofAssetIds.some(id => typeof id !== 'string' || !id.trim())
            || new Set(body.proofAssetIds).size !== body.proofAssetIds.length) {
            throw new AppError(400, 'PAYOUT_PROOFS_INVALID', '打款凭证须提供 1 至 5 张不同的图片')
          }
          proofAssetIds = body.proofAssetIds as string[]
          note = typeof body.note === 'string' ? body.note.trim() : ''
          if (note.length < 5 || note.length > 500) throw new AppError(400, 'PAYOUT_REVIEW_NOTE_REQUIRED', '请填写 5 至 500 字凭证与银行流水人工核对说明')
          const subscription = await repositories.subscriptions.findOne({ projectId: order.projectId,
            userId: participantId, pay: '已缴款' } as never, session)
          if (!subscription) throw new AppError(409, 'PAYOUT_SUBSCRIPTION_INVALID', '员工认购记录不存在')
          for (const assetId of proofAssetIds) {
            const asset = await repositories.fileAssets.getById(assetId, session)
            if (!asset || asset.status !== 'ready' || asset.purpose !== 'distribution-payout-proof'
              || asset.ownerType !== 'subscription' || asset.ownerId !== subscription.id
              || asset.createdBy !== actor.userId
              || await distributionOrders.findOne({ 'lines.payout.proofAssetIds': assetId }, { session })) {
              throw new AppError(409, 'PAYOUT_PROOF_INVALID', '打款凭证不存在、未留存或已被使用')
            }
          }
          const occupied = await bankTransactions.findOne({ transactionNo }, { session })
            || await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}fund_ledger`)
              .findOne({ transactionNo }, { session })
          if (occupied) throw new AppError(409, 'BANK_TRANSACTION_DUPLICATE', '打款流水号已被使用')
        }
        const payout = { amountCents: line.payoutCents, ...(transactionNo ? { transactionNo } : {}),
          paidAt: new Date(paidAt).toISOString(), proofAssetIds, registeredBy: actor.userId,
          ...(note ? { note } : {}) }
        const updatedLine = { ...line, payout,
          status: line.kind === 'company' ? '已确认' as const : '待员工确认' as const,
          ...(line.kind === 'company' ? { confirmedAt: new Date().toISOString() } : {}) }
        const lines = [...order.lines]
        lines[index] = updatedLine
        const updated: DistributionOrder = { ...order, lines, status: deriveDistributionStatus(lines) }
        await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}projects`)
          .updateOne({ id: order.projectId }, { $inc: { distributionRevision: 1 } }, { session })
        if (transactionNo) {
          await bankTransactions.insertOne({ transactionNo,
            sourceKey: `distribution-payout:${order.id}:${participantId}`,
            projectId: order.projectId, createdAt: new Date().toISOString() }, { session })
        }
        await distributionOrders.replaceOne({ id: order.id, status: order.status }, updated, { session })
        await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}fund_ledger`).insertOne({
          id: `LED-${randomUUID()}`, sourceKey: `distribution-payout:${order.id}:${participantId}`,
          type: line.kind === 'company' ? 'company_internal_transfer' : 'employee_distribution_payout',
          projectId: order.projectId, participantId, amountCents: line.payoutCents,
          ...(transactionNo ? { transactionNo } : {}),
          transactionKey: `distribution-payout:${order.id}:${participantId}`, proofAssetIds,
          reviewedBy: actor.userId, createdAt: new Date().toISOString()
        }, { session })
        const audit = auditRecord({ actor: actor.label, role: 'finance',
          action: line.kind === 'company' ? '登记公司内部结转' : '登记员工分配打款',
          target: `${order.id}:${participantId}`, before: { status: line.status },
          after: { status: updatedLine.status, amountCents: line.payoutCents, transactionNo } }) as AuditLog
        await repositories.auditLogs.insert(audit as never, session)
        return { updated, audit }
      })
      auditLogs.unshift(result.audit)
      return send(res, 200, { data: result.updated, message: '打款登记成功' })
    } catch (error) {
      if (error instanceof AppError) return send(res, error.status, { error: error.code, message: error.message })
      if (isDuplicateKey(error)) return send(res, 409, { error: 'PAYOUT_DUPLICATE', message: '打款明细或银行流水已登记' })
      throw error
    }
  }
  const payoutConfirmMatch = pathname.match(/^\/api\/distribution-orders\/([^/]+)\/lines\/([^/]+)\/confirm$/)
  if (payoutConfirmMatch) {
    const context = requestContext(req)
    if (context.role !== 'employee') throw new AppError(403, 'FORBIDDEN', '仅员工本人可以确认收款')
    const orderId = decodeURIComponent(payoutConfirmMatch[1])
    const participantId = decodeURIComponent(payoutConfirmMatch[2])
    if (participantId !== context.userId) throw new AppError(404, 'PAYOUT_NOT_FOUND', '收益记录不存在')
    const decision = body.decision
    if (decision !== '确认' && decision !== '异议') throw new AppError(400, 'PAYOUT_DECISION_INVALID', '请选择确认收款或提出异议')
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (decision === '异议' && (reason.length < 5 || reason.length > 200)) {
      throw new AppError(400, 'PAYOUT_ISSUE_REASON_INVALID', '异议原因须为 5 至 200 字')
    }
    const result = await mongo.withTransaction(async session => {
      const order = await distributionOrders.findOne({ id: orderId }, { session })
      const index = order?.lines.findIndex(line => line.participantId === participantId) ?? -1
      if (!order || index < 0 || order.lines[index].status !== '待员工确认'
        || !['待员工确认', '打款登记中'].includes(order.status)) {
        throw new AppError(409, 'PAYOUT_CONFIRM_INVALID', '收益尚未登记打款或已处理')
      }
      const line = order.lines[index]
      const timestamp = new Date().toISOString()
      if (decision === '确认') {
        if (body.agreementsConfirmed !== true) throw new AppError(400, 'AGREEMENT_CONFIRM_REQUIRED', '请先阅读并确认当前免责协议')
        const agreement = await agreementService.requireCurrent(body.agreementVersion, session)
        await agreementService.confirm({ version: agreement.version, userId: context.userId,
          userName: iamDisplayName(req), node: '确认收款', relatedId: `${order.id}:${participantId}` }, session)
      }
      const nextLine = { ...line, status: decision === '确认' ? '已确认' as const : '有异议' as const,
        ...(decision === '确认' ? { confirmedAt: timestamp } : { issueReason: reason, issueAt: timestamp }) }
      const lines = [...order.lines]
      lines[index] = nextLine
      const updated: DistributionOrder = { ...order, lines, status: deriveDistributionStatus(lines) }
      await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}projects`)
        .updateOne({ id: order.projectId }, { $inc: { distributionRevision: 1 } }, { session })
      await distributionOrders.replaceOne({ id: order.id, status: order.status }, updated, { session })
      const audit = auditRecord({ actor: `${context.userId} · 员工`, role: 'employee',
        action: decision === '确认' ? '确认分配收款' : '提出分配收款异议', target: `${order.id}:${participantId}`,
        before: { status: line.status }, after: { status: nextLine.status,
          ...(decision === '异议' ? { reason } : {}) } }) as AuditLog
      await repositories.auditLogs.insert(audit as never, session)
      return { updated, audit }
    })
    auditLogs.unshift(result.audit)
    return send(res, 200, { data: result.updated.lines.find(line => line.participantId === participantId),
      message: decision === '确认' ? '已确认收款' : '异议已提交' })
  }
  const payoutIssueReplyMatch = pathname.match(/^\/api\/distribution-orders\/([^/]+)\/lines\/([^/]+)\/issue-reply$/)
  if (payoutIssueReplyMatch) {
    const actor = financeOperator(req)
    const orderId = decodeURIComponent(payoutIssueReplyMatch[1])
    const participantId = decodeURIComponent(payoutIssueReplyMatch[2])
    const reply = typeof body.reply === 'string' ? body.reply.trim() : ''
    if (reply.length < 5 || reply.length > 200) return send(res, 400, { error: 'PAYOUT_ISSUE_REPLY_INVALID', message: '处理回复须为 5 至 200 字' })
    const result = await mongo.withTransaction(async session => {
      const order = await distributionOrders.findOne({ id: orderId }, { session })
      const index = order?.lines.findIndex(line => line.participantId === participantId) ?? -1
      if (!order || index < 0 || order.status !== '有异议' || order.lines[index].status !== '有异议') {
        throw new AppError(409, 'PAYOUT_ISSUE_INVALID', '当前没有待处理的收款异议')
      }
      const line = order.lines[index]
      const lines = [...order.lines]
      lines[index] = { ...line, status: '待员工确认', issueReply: reply,
        issueResolvedAt: new Date().toISOString() }
      const updated: DistributionOrder = { ...order, lines, status: deriveDistributionStatus(lines) }
      await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}projects`)
        .updateOne({ id: order.projectId }, { $inc: { distributionRevision: 1 } }, { session })
      await distributionOrders.replaceOne({ id: order.id, status: '有异议' }, updated, { session })
      const audit = auditRecord({ actor: actor.label, role: 'finance', action: '回复分配收款异议',
        target: `${order.id}:${participantId}`, before: { status: line.status, reason: line.issueReason },
        after: { status: '待员工确认', reply } }) as AuditLog
      await repositories.auditLogs.insert(audit as never, session)
      return { line: lines[index], audit }
    })
    auditLogs.unshift(result.audit)
    return send(res, 200, { data: result.line, message: '异议已处理，请员工重新确认' })
  }
  if (pathname === '/api/confirmed-costs') {
    const actor = financeOperator(req)
    const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : ''
    if (!Array.isArray(body.proofAssetIds) || body.proofAssetIds.some(id => typeof id !== 'string')) {
      return send(res, 400, { error: 'COST_PROOFS_INVALID', message: '请提供已上传的成本凭证编号' })
    }
    try {
      const result = await mongo.withTransaction(async session => {
        const project = await repositories.projects.getById(projectId, session)
        if (!project || !['待回款', '回款中', '待分配'].includes(project.status)
          || !await procurementPayments.findOne({ projectId }, { session })) {
          throw new AppError(409, 'COST_PROJECT_INVALID', '众筹单不允许登记其他成本')
        }
        const record = validateCostRegistration({ id: `COST-${randomUUID()}`, projectId,
          amountCents: body.amountCents as number,
          transactionNo: typeof body.transactionNo === 'string' ? body.transactionNo : '',
          paidAt: body.paidAt as string, proofAssetIds: body.proofAssetIds as string[],
          reason: typeof body.reason === 'string' ? body.reason : '', registeredBy: actor.userId }, new Date())
        const occupied = await bankTransactions.findOne({ transactionNo: record.transactionNo }, { session })
          || await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}fund_ledger`)
            .findOne({ transactionNo: record.transactionNo }, { session })
        if (occupied) throw new AppError(409, 'BANK_TRANSACTION_DUPLICATE', '成本付款流水号已被使用')
        for (const assetId of record.proofAssetIds) {
          const asset = await repositories.fileAssets.getById(assetId, session)
          if (!asset || asset.status !== 'ready' || asset.purpose !== 'confirmed-cost-proof'
            || asset.ownerType !== 'project' || asset.ownerId !== projectId || asset.createdBy !== actor.userId
            || await confirmedCosts.findOne({ proofAssetIds: assetId }, { session })) {
            throw new AppError(409, 'COST_PROOF_INVALID', '成本凭证不存在、未留存或已被使用')
          }
        }
        await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}projects`)
          .updateOne({ id: projectId }, { $inc: { costRevision: 1 } }, { session })
        await bankTransactions.insertOne({ transactionNo: record.transactionNo,
          sourceKey: `confirmed-cost:${record.id}`, projectId, createdAt: record.createdAt }, { session })
        await confirmedCosts.insertOne(record, { session })
        const audit = auditRecord({ actor: actor.label, role: 'finance', action: '登记其他成本并提交公司复核',
          target: record.id, before: null, after: { projectId, amountCents: record.amountCents,
            transactionNo: record.transactionNo } }) as AuditLog
        await repositories.auditLogs.insert(audit as never, session)
        return { record, audit }
      })
      auditLogs.unshift(result.audit)
      return send(res, 201, { data: result.record, message: '其他成本已提交公司复核' })
    } catch (error) {
      if (error instanceof AppError) return send(res, error.status, { error: error.code, message: error.message })
      if (isDuplicateKey(error)) return send(res, 409, { error: 'COST_DUPLICATE', message: '成本流水号或单据已存在' })
      if (error instanceof Error && /成本|金额|时间|流水号|凭证/.test(error.message)) {
        return send(res, 400, { error: 'COST_INVALID', message: error.message })
      }
      throw error
    }
  }
  const costReviewMatch = pathname.match(/^\/api\/confirmed-costs\/([^/]+)\/review$/)
  if (costReviewMatch) {
    const actor = managementActor(req, ['super_admin'])
    const id = decodeURIComponent(costReviewMatch[1])
    try {
      const result = await mongo.withTransaction(async session => {
        const record = await confirmedCosts.findOne({ id }, { session })
        if (!record) throw new AppError(404, 'COST_NOT_FOUND', '成本记录不存在')
        if (record.status !== '待公司复核') throw new AppError(409, 'COST_ALREADY_REVIEWED', '成本已复核')
        if (record.registeredBy === actor.userId) throw new AppError(403, 'COST_SELF_REVIEW', '登记人不能复核自己的成本')
        const project = await repositories.projects.getById(record.projectId, session)
        if (!project || !['待回款', '回款中', '待分配'].includes(project.status)) {
          throw new AppError(409, 'COST_PROJECT_INVALID', '众筹单状态已变化')
        }
        const decision = body.decision
        const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
        if (decision !== '通过' && decision !== '驳回') throw new AppError(400, 'COST_DECISION_INVALID', '复核结果无效')
        if (decision === '驳回' && (reason.length < 5 || reason.length > 200)) {
          throw new AppError(400, 'COST_REJECT_REASON_INVALID', '驳回原因须为 5 至 200 字')
        }
        const updated: ConfirmedCost = { ...record, status: decision === '通过' ? '已确认' : '已驳回',
          reviewedBy: actor.userId, reviewedAt: new Date().toISOString(),
          ...(decision === '驳回' ? { rejectReason: reason } : {}) }
        await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}projects`)
          .updateOne({ id: record.projectId }, { $inc: { costRevision: 1 } }, { session })
        await confirmedCosts.replaceOne({ id, status: '待公司复核' }, updated, { session })
        if (decision === '通过') {
          await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}fund_ledger`).insertOne({
            id: `LED-${randomUUID()}`, sourceKey: `confirmed-cost:${id}`, type: 'other_confirmed_cost',
            projectId: record.projectId, amountCents: record.amountCents,
            transactionNo: record.transactionNo, transactionKey: `confirmed-cost:${id}`,
            proofAssetIds: record.proofAssetIds, reviewedBy: actor.userId, createdAt: updated.reviewedAt
          }, { session })
        } else {
          await bankTransactions.deleteOne({ transactionNo: record.transactionNo,
            sourceKey: `confirmed-cost:${id}` }, { session })
        }
        const audit = auditRecord({ actor: actor.label, role: 'super_admin',
          action: decision === '通过' ? '确认其他成本' : '驳回其他成本',
          target: id, before: { status: record.status }, after: { status: updated.status, reason: updated.rejectReason } }) as AuditLog
        await repositories.auditLogs.insert(audit as never, session)
        return { updated, audit }
      })
      auditLogs.unshift(result.audit)
      return send(res, 200, { data: result.updated, message: result.updated.status === '已确认' ? '成本已确认' : '成本已驳回' })
    } catch (error) {
      if (error instanceof AppError) return send(res, error.status, { error: error.code, message: error.message })
      if (isDuplicateKey(error)) return send(res, 409, { error: 'COST_DUPLICATE', message: '成本状态已变化' })
      throw error
    }
  }
  if (pathname === '/api/receipt-batches') {
    const actor = financeOperator(req)
    if (body.recognitionFailed !== true) return send(res, 409, { error: 'RECEIPT_OCR_NOT_AVAILABLE', message: '回款凭证尚无可信的金额、流水号和到账时间识别结果，请填写人工核对说明' })
    if (!Array.isArray(body.lines) || body.lines.length < 1 || body.lines.length > 20
      || body.lines.some(line => !line || typeof line !== 'object' || typeof line.projectId !== 'string')) {
      return send(res, 400, { error: 'RECEIPT_LINES_INVALID', message: '请选择 1 至 20 张众筹单并填写拆分金额' })
    }
    if (!Array.isArray(body.proofAssetIds) || body.proofAssetIds.some(id => typeof id !== 'string')) {
      return send(res, 400, { error: 'RECEIPT_PROOFS_INVALID', message: '请提供已上传的回款凭证编号' })
    }
    const lines = body.lines as Array<{ projectId: string; amountCents: number }>
    const proofAssetIds = body.proofAssetIds as string[]
    try {
      const result = await mongo.withTransaction(async session => {
        const projectIds = lines.map(line => line.projectId)
        const linked = await mongo.db.collection<Project>(`${appConfig.mongodb.collectionPrefix}projects`)
          .find({ id: { $in: projectIds } }, { session }).toArray()
        if (linked.length !== new Set(projectIds).size) throw new AppError(409, 'RECEIPT_PROJECT_INVALID', '众筹单不存在或重复')
        const receivables: Record<string, number> = {}
        for (const project of linked) {
          if (!['待回款', '回款中', '待分配'].includes(project.status)
            || !await procurementPayments.findOne({ projectId: project.id }, { session })) {
            throw new AppError(409, 'PROJECT_NOT_RECEIPT_READY', `众筹单【${project.id}】尚未完成采购付款或已关闭回款`)
          }
          receivables[project.id] = Math.round(project.salesAmount * 100)
        }
        const existing = await receiptBatches.find({ 'lines.projectId': { $in: projectIds } }, { session }).toArray()
        const transactionNo = typeof body.transactionNo === 'string' ? body.transactionNo.trim() : ''
        const occupied = await bankTransactions.findOne({ transactionNo }, { session })
          || await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}fund_ledger`).findOne({ transactionNo }, { session })
        const batch = validateReceiptRegistration({ id: `REC-${randomUUID()}`,
          kind: body.kind as ReceiptBatch['kind'], transactionNo,
          bookedAt: body.bookedAt as string, totalCents: body.totalCents as number,
          lines, proofAssetIds, registeredBy: actor.userId,
          reason: typeof body.reason === 'string' ? body.reason : undefined,
          recognitionFailed: true, note: typeof body.note === 'string' ? body.note : undefined
        }, existing, receivables, new Date(), occupied ? [transactionNo] : [])
        for (const assetId of batch.proofAssetIds) {
          const asset = await repositories.fileAssets.getById(assetId, session)
          if (!asset || asset.status !== 'ready' || asset.purpose !== 'customer-receipt-proof'
            || asset.ownerType !== 'project' || asset.ownerId !== lines[0].projectId || asset.createdBy !== actor.userId) {
            throw new AppError(409, 'RECEIPT_PROOF_INVALID', '回款凭证不存在、未留存或不属于当前登记人和首张众筹单')
          }
          if (await receiptBatches.findOne({ proofAssetIds: assetId }, { session })) {
            throw new AppError(409, 'RECEIPT_PROOF_USED', '回款凭证已被其他流水使用')
          }
        }
        // Touch the same project documents to serialize concurrent top-up gap checks.
        for (const project of linked) {
          await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}projects`)
            .updateOne({ id: project.id }, { $inc: { receiptRevision: 1 },
              ...(project.status === '待回款' ? { $set: { status: '回款中', statusType: 'warning' } } : {}) }, { session })
        }
        await bankTransactions.insertOne({ transactionNo: batch.transactionNo,
          sourceKey: `receipt-batch:${batch.id}`, projectId: lines[0].projectId,
          createdAt: now() }, { session })
        await receiptBatches.insertOne(batch, { session })
        const audit = auditRecord({ actor: actor.label, role: 'finance', action: batch.kind === '公司补款' ? '登记公司补款' : '登记客户回款',
          target: batch.id, before: null, after: { transactionNo: batch.transactionNo, totalCents: batch.totalCents,
            lines: batch.lines, recognitionStatus: batch.recognitionStatus } }) as AuditLog
        await repositories.auditLogs.insert(audit as never, session)
        return { batch, linked, audit }
      })
      for (const project of result.linked) {
        if (project.status !== '待回款') continue
        const index = projects.findIndex(item => item.id === project.id)
        if (index >= 0) projects.splice(index, 1, { ...project, status: '回款中', statusType: 'warning' })
      }
      auditLogs.unshift(result.audit)
      return send(res, 201, { data: result.batch,
        message: result.batch.kind === '公司补款' ? '补款登记成功，请等待公司复核' : '回款登记成功，请复核' })
    } catch (error) {
      if (error instanceof AppError) return send(res, error.status, { error: error.code, message: error.message })
      if (isDuplicateKey(error)) return send(res, 409, { error: 'RECEIPT_DUPLICATE', message: '流水号或凭证已被使用' })
      if (error instanceof Error && error.message.includes('已被使用')) {
        return send(res, 409, { error: 'RECEIPT_DUPLICATE', message: error.message })
      }
      if (error instanceof Error && /回款|补款|凭证|流水号|金额|到账|众筹单|拆分|登记/.test(error.message)) {
        return send(res, 400, { error: 'RECEIPT_INVALID', message: error.message })
      }
      throw error
    }
  }
  const receiptReviewMatch = pathname.match(/^\/api\/receipt-batches\/([^/]+)\/review$/)
  if (receiptReviewMatch) {
    const context = requestContext(req)
    if (context.role !== 'finance' && context.role !== 'super_admin') throw new AppError(403, 'FORBIDDEN', '当前角色无权复核回款')
    const batchId = decodeURIComponent(receiptReviewMatch[1])
    try {
      const result = await mongo.withTransaction(async session => {
        const batch = await receiptBatches.findOne({ id: batchId }, { session })
        if (!batch) throw new AppError(404, 'RECEIPT_NOT_FOUND', '回款记录不存在')
        const linked = await mongo.db.collection<Project>(`${appConfig.mongodb.collectionPrefix}projects`)
          .find({ id: { $in: batch.lines.map(line => line.projectId) } }, { session }).toArray()
        if (linked.length !== batch.lines.length || linked.some(project => !['回款中', '待分配'].includes(project.status))) {
          throw new AppError(409, 'RECEIPT_PROJECT_LOCKED', '众筹单状态已变化，不能复核')
        }
        const existing = await receiptBatches.find({ 'lines.projectId': { $in: batch.lines.map(line => line.projectId) } }, { session }).toArray()
        const receivables = Object.fromEntries(linked.map(project => [project.id, Math.round(project.salesAmount * 100)]))
        const reviewed = reviewReceiptBatch({ batch, decision: body.decision as '通过' | '驳回',
          reviewerId: context.userId, reviewerRole: context.role === 'finance' ? 'finance' : 'company',
          actualBankCents: body.actualBankCents as number,
          actualBankTransactionNo: body.actualBankTransactionNo as string,
          reason: body.reason as string, now: new Date(), existing, receivables })
        for (const project of linked) {
          await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}projects`)
            .updateOne({ id: project.id }, { $inc: { receiptRevision: 1 } }, { session })
        }
        await receiptBatches.replaceOne({ id: batch.id, status: '待复核' }, reviewed, { session })
        if (reviewed.status === '已驳回') {
          await bankTransactions.deleteOne({ transactionNo: batch.transactionNo,
            sourceKey: `receipt-batch:${batch.id}` }, { session })
        } else {
          for (const line of reviewed.lines) {
            await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}fund_ledger`).insertOne({
              id: `LED-${randomUUID()}`, sourceKey: `receipt:${batch.id}:${line.projectId}`,
              type: batch.kind === '客户回款' ? 'customer_receipt' : 'company_topup',
              projectId: line.projectId, amountCents: line.amountCents,
              transactionNo: batch.transactionNo, transactionKey: `receipt:${batch.id}:${line.projectId}`,
              proofAssetIds: batch.proofAssetIds, reviewedBy: context.userId, createdAt: now()
            }, { session })
          }
          for (const line of reviewed.returns ?? []) {
            await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}fund_ledger`).insertOne({
              id: `LED-${randomUUID()}`, sourceKey: `topup-return:${batch.id}:${line.projectId}`,
              type: 'company_topup_return', projectId: line.projectId, amountCents: line.amountCents,
              transactionKey: `topup-return:${batch.id}:${line.projectId}`, proofAssetIds: [],
              reviewedBy: context.userId, createdAt: now()
            }, { session })
          }
          for (const project of linked) {
            const summary = summarizeProjectReceipts([...existing.filter(item => item.id !== batch.id), reviewed],
              project.id, receivables[project.id])
            if (summary.gapCents === 0 && project.status !== '待分配') {
              await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}projects`).updateOne({ id: project.id },
                { $set: { status: '待分配', statusType: 'success' } }, { session })
              project.status = '待分配'
            }
          }
        }
        const audit = auditRecord({ actor: `${context.userId} · ${context.role === 'finance' ? '财务' : '公司'}`,
          role: context.role, action: reviewed.status === '已通过' ? '复核通过回款' : '驳回回款',
          target: batch.id, before: { status: batch.status }, after: { status: reviewed.status,
            returns: reviewed.returns, reason: reviewed.rejectReason } }) as AuditLog
        await repositories.auditLogs.insert(audit as never, session)
        return { reviewed, linked, audit }
      })
      for (const project of result.linked) {
        const index = projects.findIndex(item => item.id === project.id)
        if (index >= 0) projects.splice(index, 1, { ...projects[index], status: project.status,
          statusType: project.status === '待分配' ? 'success' : projects[index].statusType })
      }
      auditLogs.unshift(result.audit)
      return send(res, 200, { data: result.reviewed,
        message: result.reviewed.status === '已通过' ? '复核通过' : '已驳回，请重新登记' })
    } catch (error) {
      if (error instanceof AppError) return send(res, error.status, { error: error.code, message: error.message })
      if (isDuplicateKey(error)) return send(res, 409, { error: 'RECEIPT_ALREADY_REVIEWED', message: '回款已经复核，请刷新' })
      if (error instanceof Error && /回款|补款|复核|金额|流水号|驳回|缺口/.test(error.message)) {
        return send(res, 409, { error: 'RECEIPT_REVIEW_INVALID', message: error.message })
      }
      throw error
    }
  }
  const differenceMatch = pathname.match(/^\/api\/projects\/([^/]+)\/receipt-differences$/)
  if (differenceMatch) {
    const actor = financeOperator(req)
    const projectId = decodeURIComponent(differenceMatch[1])
    try {
      const result = await mongo.withTransaction(async session => {
        const project = await repositories.projects.getById(projectId, session)
        if (!project || !['回款中', '待分配'].includes(project.status)) {
          throw new AppError(409, 'RECEIPT_DIFFERENCE_PROJECT_INVALID', '众筹单不存在或不允许登记回款差异')
        }
        const batches = await receiptBatches.find({ 'lines.projectId': projectId }, { session }).toArray()
        const excessCents = summarizeProjectReceipts(batches, projectId, Math.round(project.salesAmount * 100)).excessCents
        const existing = await receiptDifferences.find({ projectId }, { session }).toArray()
        const difference = validateReceiptDifference({ id: `RDIFF-${randomUUID()}`, projectId,
          amountCents: body.amountCents as number,
          destination: body.destination as ReceiptDifference['destination'],
          reason: typeof body.reason === 'string' ? body.reason : '',
          refundTransactionNo: typeof body.refundTransactionNo === 'string' ? body.refundTransactionNo : undefined,
          registeredBy: actor.userId }, excessCents, existing, new Date())
        if (difference.refundTransactionNo) {
          const occupied = await bankTransactions.findOne({ transactionNo: difference.refundTransactionNo }, { session })
            || await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}fund_ledger`)
              .findOne({ transactionNo: difference.refundTransactionNo }, { session })
          if (occupied) throw new AppError(409, 'BANK_TRANSACTION_DUPLICATE', '退款流水号已被使用')
        }
        await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}projects`)
          .updateOne({ id: projectId }, { $inc: { receiptRevision: 1 } }, { session })
        if (difference.refundTransactionNo) {
          await bankTransactions.insertOne({ transactionNo: difference.refundTransactionNo,
            sourceKey: `receipt-difference:${difference.id}`, projectId, createdAt: difference.createdAt }, { session })
        }
        await receiptDifferences.insertOne(difference, { session })
        await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}fund_ledger`).insertOne({
          id: `LED-${randomUUID()}`, sourceKey: `receipt-difference:${difference.id}`,
          type: difference.destination === '退回客户' ? 'customer_refund' : 'company_excess',
          projectId, amountCents: difference.amountCents,
          ...(difference.refundTransactionNo ? { transactionNo: difference.refundTransactionNo } : {}),
          transactionKey: `receipt-difference:${difference.id}`, proofAssetIds: [],
          reviewedBy: actor.userId, createdAt: difference.createdAt
        }, { session })
        const audit = auditRecord({ actor: actor.label, role: 'finance', action: '登记回款差异去向',
          target: difference.id, before: null, after: { projectId, amountCents: difference.amountCents,
            destination: difference.destination, refundTransactionNo: difference.refundTransactionNo } }) as AuditLog
        await repositories.auditLogs.insert(audit as never, session)
        return { difference, audit }
      })
      auditLogs.unshift(result.audit)
      return send(res, 201, { data: result.difference, message: '差异去向已登记' })
    } catch (error) {
      if (error instanceof AppError) return send(res, error.status, { error: error.code, message: error.message })
      if (isDuplicateKey(error)) return send(res, 409, { error: 'RECEIPT_DIFFERENCE_DUPLICATE', message: '退款流水号或差异单已存在' })
      if (error instanceof Error && /差异|金额|退款流水号|公司/.test(error.message)) {
        return send(res, 400, { error: 'RECEIPT_DIFFERENCE_INVALID', message: error.message })
      }
      throw error
    }
  }
  const distributionGenerateMatch = pathname.match(/^\/api\/projects\/([^/]+)\/distribution-orders$/)
  if (distributionGenerateMatch) {
    const actor = financeOperator(req)
    const projectId = decodeURIComponent(distributionGenerateMatch[1])
    try {
      const result = await mongo.withTransaction(async session => {
        const { project, input } = await distributionSnapshot(projectId, session)
        if (project.status !== '待分配') throw new AppError(409, 'PROJECT_NOT_DISTRIBUTION_READY', '众筹单尚未进入待分配')
        const existing = await distributionOrders.find({ projectId }, { session }).toArray()
        if (existing.some(distributionOrderIsActive)) throw new AppError(409, 'DISTRIBUTION_EXISTS', '该众筹单已有有效分配单')
        const order = makeDistributionOrder({ ...input, id: `DIST-${randomUUID()}`, projectId,
          generatedBy: actor.userId, createdAt: new Date().toISOString() })
        await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}projects`)
          .updateOne({ id: projectId, status: '待分配' }, { $set: { status: '分配中', statusType: 'warning' },
            $inc: { distributionRevision: 1 } }, { session })
        await distributionOrders.insertOne(order, { session })
        const audit = auditRecord({ actor: actor.label, role: 'finance', action: '生成分配单',
          target: order.id, before: null, after: { projectId, profitCents: order.profitCents,
            payoutTotalCents: order.payoutTotalCents, confirmedCostsCents: order.confirmedCostsCents } }) as AuditLog
        await repositories.auditLogs.insert(audit as never, session)
        return { order, project, audit }
      })
      const index = projects.findIndex(project => project.id === projectId)
      if (index >= 0) projects.splice(index, 1, { ...result.project, status: '分配中', statusType: 'warning' })
      auditLogs.unshift(result.audit)
      return send(res, 201, { data: result.order, message: '分配单已生成，请审批' })
    } catch (error) {
      if (error instanceof AppError) return send(res, error.status, { error: error.code, message: error.message })
      if (isDuplicateKey(error)) return send(res, 409, { error: 'DISTRIBUTION_DUPLICATE', message: '分配单已存在' })
      if (error instanceof Error && /分配|份数|金额|回款|成本|利润|采购|认购/.test(error.message)) {
        return send(res, 409, { error: 'DISTRIBUTION_INVALID', message: error.message })
      }
      throw error
    }
  }
  const distributionActionMatch = pathname.match(/^\/api\/distribution-orders\/([^/]+)\/(approve|reject|void)$/)
  if (distributionActionMatch) {
    const actor = financeOperator(req)
    const orderId = decodeURIComponent(distributionActionMatch[1])
    const action = distributionActionMatch[2]
    try {
      const result = await mongo.withTransaction(async session => {
        const order = await distributionOrders.findOne({ id: orderId }, { session })
        if (!order) throw new AppError(404, 'DISTRIBUTION_NOT_FOUND', '分配单不存在')
        if (action === 'void' && order.status !== '待审批' && order.status !== '已驳回'
          || action !== 'void' && order.status !== '待审批') {
          throw new AppError(409, 'DISTRIBUTION_STATUS_INVALID', '当前分配单状态不允许此操作')
        }
        const project = await repositories.projects.getById(order.projectId, session)
        const rejectedVoid = action === 'void' && order.status === '已驳回'
        if (!project || (!rejectedVoid && project.status !== '分配中')) {
          throw new AppError(409, 'PROJECT_DISTRIBUTION_LOCKED', '众筹单状态已变化')
        }
        let next: DistributionOrder
        if (action === 'approve') {
          const { payment, input } = await distributionSnapshot(order.projectId, session)
          if (payment.operatorId === actor.userId) {
            throw new AppError(403, 'DISTRIBUTION_SELF_APPROVAL', '您参与了该众筹单的付款登记，不可审批分配单')
          }
          const refreshed = makeDistributionOrder({ ...input, id: order.id, projectId: order.projectId,
            generatedBy: order.generatedBy, createdAt: order.createdAt })
          if (JSON.stringify(refreshed.lines) !== JSON.stringify(order.lines)
            || refreshed.profitCents !== order.profitCents || refreshed.payoutTotalCents !== order.payoutTotalCents) {
            throw new AppError(409, 'DISTRIBUTION_CHANGED', '分配依据已变化，请先作废并重新生成')
          }
          next = { ...order, status: '已审批', approvedBy: actor.userId, approvedAt: new Date().toISOString() }
        } else if (action === 'reject') {
          const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
          if (reason.length < 5 || reason.length > 200) throw new AppError(400, 'DISTRIBUTION_REASON_INVALID', '驳回原因须为 5 至 200 字')
          next = { ...order, status: '已驳回', rejectedBy: actor.userId,
            rejectedAt: new Date().toISOString(), rejectReason: reason }
        } else {
          next = { ...order, status: '已作废', voidedBy: actor.userId, voidedAt: new Date().toISOString() }
        }
        await distributionOrders.replaceOne({ id: order.id, status: order.status }, next, { session })
        if (action !== 'approve' && !rejectedVoid) {
          await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}projects`)
            .updateOne({ id: order.projectId }, { $set: { status: '待分配', statusType: 'success' },
              $inc: { distributionRevision: 1 } }, { session })
        } else if (!rejectedVoid) {
          await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}projects`)
            .updateOne({ id: order.projectId }, { $inc: { distributionRevision: 1 } }, { session })
        }
        const audit = auditRecord({ actor: actor.label, role: 'finance',
          action: action === 'approve' ? '审批通过分配单' : action === 'reject' ? '驳回分配单' : '作废分配单',
          target: order.id, before: { status: order.status }, after: { status: next.status,
            reason: next.rejectReason } }) as AuditLog
        await repositories.auditLogs.insert(audit as never, session)
        return { next, project: project as Project, audit }
      })
      if (action !== 'approve' && result.project.status === '分配中') {
        const index = projects.findIndex(project => project.id === result.project.id)
        if (index >= 0) projects.splice(index, 1, { ...result.project, status: '待分配', statusType: 'success' })
      }
      auditLogs.unshift(result.audit)
      return send(res, 200, { data: result.next, message: action === 'approve' ? '审批通过' : action === 'reject' ? '已驳回' : '已作废' })
    } catch (error) {
      if (error instanceof AppError) return send(res, error.status, { error: error.code, message: error.message })
      if (isDuplicateKey(error)) return send(res, 409, { error: 'DISTRIBUTION_DUPLICATE', message: '分配单状态已变化' })
      if (error instanceof Error && /分配|份数|金额|回款|成本|利润|采购|认购/.test(error.message)) {
        return send(res, 409, { error: 'DISTRIBUTION_INVALID', message: error.message })
      }
      throw error
    }
  }
  const procurementPaymentMatch = pathname.match(/^\/api\/projects\/([^/]+)\/procurement-payment$/)
  if (procurementPaymentMatch) {
    const actor = financeOperator(req)
    const projectId = decodeURIComponent(procurementPaymentMatch[1])
    if (body.recognitionFailed !== true) return send(res, 409, { error: 'PAYMENT_OCR_NOT_AVAILABLE', message: '付款凭证尚无可信识别结果，请按识别失败路径填写情况说明' })
    if (!Array.isArray(body.proofAssetIds) || body.proofAssetIds.some(id => typeof id !== 'string')) {
      return send(res, 400, { error: 'PAYMENT_PROOFS_INVALID', message: '请提供付款凭证文件编号' })
    }
    if (typeof body.paidAt !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(body.paidAt)) {
      return send(res, 400, { error: 'PAYMENT_TIME_INVALID', message: '付款时间须包含时区' })
    }
    try {
      const result = await mongo.withTransaction(async session => {
        const { project, rule, records, funding, fundingInput } = await procurementFundingSnapshot(projectId, session)
        if (!['已满额', '已截止'].includes(project.status)) throw new AppError(409, 'PROJECT_NOT_PAYMENT_READY', '该众筹单尚未进入付款前阶段')
        const cutoff = Date.parse(`${rule.paymentCutoffAt?.replace(' ', 'T') ?? ''}+08:00`)
        if (!Number.isFinite(cutoff) || Date.now() < cutoff) throw new AppError(409, 'PAYMENT_CUTOFF_NOT_REACHED', '缴款截止时间尚未到达')
        const prior = await procurementPayments.findOne({ projectId }, { session })
        if (prior) throw new AppError(409, 'PROCUREMENT_PAYMENT_EXISTS', '该众筹单已登记采购付款')
        const transactionNo = typeof body.transactionNo === 'string' ? body.transactionNo.trim() : ''
        const priorBank = await bankTransactions.findOne({ transactionNo }, { session })
        const legacyBank = await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}fund_ledger`).findOne({ transactionNo }, { session })
        const validated = validateProcurementPayment({ ...fundingInput, projectId,
          amountCents: body.amountCents as number, transactionNo, paidAt: body.paidAt as string,
          proofAssetIds: body.proofAssetIds as string[], recognitionFailed: true,
          companyFundsConfirmed: body.companyFundsConfirmed === true,
          note: typeof body.note === 'string' ? body.note : '',
          operatorId: actor.userId, alreadyRegistered: false
        }, priorBank || legacyBank ? [transactionNo] : [], new Date())
        for (const assetId of validated.proofAssetIds) {
          const asset = await repositories.fileAssets.getById(assetId, session)
          if (!asset || asset.status !== 'ready' || asset.purpose !== 'procurement-payment-proof'
            || asset.ownerType !== 'project' || asset.ownerId !== projectId || asset.createdBy !== actor.userId) {
            throw new AppError(409, 'PAYMENT_PROOF_INVALID', '付款凭证不存在、未留存或不属于当前财务登记人')
          }
        }
        const createdAt = now()
        const payment: ProcurementPayment = { id: `PPAY-${randomUUID()}`, ...validated, createdAt }
        await bankTransactions.insertOne({ transactionNo: payment.transactionNo,
          sourceKey: `procurement-payment:${projectId}`, projectId, createdAt }, { session })
        await procurementPayments.insertOne(payment, { session })
        const companyRecords = records.filter(record => record.companyKind === 'front' || record.companyKind === 'backstop')
        for (const company of companyRecords) {
          if (company.pay !== '公司待出资') throw new AppError(409, 'COMPANY_CONTRIBUTION_STATUS_INVALID', '公司认购状态异常，请先核对')
          await repositories.subscriptions.replace({ ...company, pay: '已缴款', action: '查看出资',
            reviewedBy: actor.label, reviewedAt: createdAt }, session)
          await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}fund_ledger`).insertOne({
            id: `LED-${randomUUID()}`, sourceKey: `company-contribution:${company.id}`,
            type: 'company_contribution', projectId, subscriptionId: company.id,
            participantId: 'company', shares: company.shares, amountCents: Math.round(company.amount * 100),
            transactionKey: `company-contribution:${company.id}`, proofAssetIds: [],
            reviewedBy: actor.label, createdAt
          }, { session })
        }
        await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}fund_ledger`).insertOne({
          id: `LED-${randomUUID()}`, sourceKey: `procurement-payment:${projectId}`,
          type: 'procurement_payment', projectId, amountCents: payment.amountCents,
          transactionNo: payment.transactionNo, transactionKey: `bank:${payment.transactionNo}`,
          proofAssetIds: payment.proofAssetIds, reviewedBy: actor.label, createdAt
        }, { session })
        const updated = { ...project, status: '待回款' as const, statusType: 'warning' as const,
          purchasePaymentId: payment.id, purchasePaidAt: payment.paidAt,
          purchasePaidAmount: payment.amountCents / 100 }
        await repositories.projects.replace(updated, session)
        const audit = auditRecord({ actor: actor.label, role: 'finance', action: '登记采购付款并确认公司出资到位',
          target: projectId, before: { status: project.status }, after: { status: updated.status,
            paymentId: payment.id, amountCents: payment.amountCents, companyCents: funding.companyCents,
            companyFundsConfirmed: true, recognitionStatus: payment.recognitionStatus } }) as AuditLog
        await repositories.auditLogs.insert(audit as never, session)
        return { payment, updated, companyRecords, audit }
      })
      const projectIndex = projects.findIndex(project => project.id === projectId)
      if (projectIndex >= 0) projects.splice(projectIndex, 1, result.updated as Project)
      for (const company of result.companyRecords) {
        const index = subscriptions.findIndex(record => record.id === company.id)
        if (index >= 0) subscriptions.splice(index, 1, { ...company, pay: '已缴款', action: '查看出资',
          reviewedBy: actor.label, reviewedAt: result.audit.time } as Subscription)
      }
      auditLogs.unshift(result.audit)
      return send(res, 201, { data: result.payment, message: '采购付款登记成功，公司出资确认与资金台账已同步记录' })
    } catch (error) {
      if (error instanceof AppError) return send(res, error.status, { error: error.code, message: error.message })
      if (isDuplicateKey(error)) return send(res, 409, { error: 'PAYMENT_DUPLICATE', message: '项目付款或银行流水号已登记' })
      if (error instanceof RangeError || error instanceof Error && /付款|缴款|公司出资|流水号|凭证|金额/.test(error.message)) {
        return send(res, 400, { error: 'PAYMENT_INVALID', message: error.message })
      }
      throw error
    }
  }
  if (pathname === '/api/agreements/confirm-view-code') {
    const context = requestContext(req)
    if (context.role !== 'employee' || body.agreementsConfirmed !== true) throw new AppError(403, 'FORBIDDEN', '只有员工本人确认协议后可以查看缴款码')
    const subscriptionId = String(body.subscriptionId ?? '')
    const subscription = await repositories.subscriptions.getById(subscriptionId)
    if (!subscription || subscription.userId !== context.userId || subscription.pay === '已释放') throw new AppError(404, 'SUBSCRIPTION_NOT_FOUND', '认购记录不存在')
    const rule = rules.find(item => item.projectId === subscription.projectId && item.status === '已启用')
    const code = receivingCodes.find(item => item.id === rule?.receivingCodeId && item.status === '启用')
    if (!code?.imageAssetId) throw new AppError(409, 'RECEIVING_CODE_UNAVAILABLE', '当前项目没有可用缴款码图片')
    await mongo.withTransaction(async session => {
      const current = await agreementService.requireCurrent(body.agreementVersion, session)
      await agreementService.confirm({ version: current.version, userId: context.userId, userName: iamDisplayName(req), node: '查看缴款码', relatedId: subscriptionId, codeId: code.id }, session)
      await repositories.auditLogs.insert(auditRecord({ actor: `${context.userId} · 员工`, role: 'employee', action: '确认协议并查看缴款码', target: code.id, before: null, after: { agreementVersion: current.version, subscriptionId } }) as never, session)
      return true
    })
    return send(res, 200, { data: { codeId: code.id, imageAssetId: code.imageAssetId } })
  }

  if (pathname === '/api/invoices/pending/delete') {
    const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : ''
    const assetId = typeof body.assetId === 'string' ? body.assetId.trim() : ''
    const proofId = typeof body.settlementProofId === 'string' ? body.settlementProofId.trim() : ''
    if (!projectId || !assetId || !proofId) return send(res, 400, { error: 'PENDING_INVOICE_REQUIRED', message: '缺少待确认发票标识' })
    const asset = await fileAssetService.getReadyAsset(assetId)
    if (!asset || asset.purpose !== 'settlement-invoice' || asset.ownerType !== 'project' || asset.ownerId !== projectId) {
      return send(res, 404, { error: 'FILE_NOT_FOUND', message: '待确认发票不存在' })
    }
    if (asset.createdBy !== settlementOperator!.userId) throw new AppError(403, 'FORBIDDEN', '只能删除本人上传的待确认发票')
    const project = await repositories.projects.getById(projectId)
    if (!project) return send(res, 404, { error: 'PROJECT_NOT_FOUND', message: '项目不存在' })
    if (project.settlementInvoices?.some(invoice => invoice.assetId === asset.id)) {
      return send(res, 409, { error: 'INVOICE_ALREADY_CONFIRMED', message: '已确认结算的凭证不能删除' })
    }
    let proof: ReturnType<typeof ocrProofStore.consume>
    try {
      proof = ocrProofStore.consume({ proofId, projectId, assetId: asset.id, imageDigest: asset.sha256, fileName: asset.originalName })
    } catch (error) {
      return send(res, 409, { error: 'OCR_PROOF_INVALID', message: error instanceof Error ? error.message : '识别凭证无效' })
    }
    try {
      await fileAssetService.deleteBinding(asset.id, async (_asset, session) => {
        const latestProject = await repositories.projects.getById(projectId, session)
        if (!latestProject) throw new AppError(404, 'PROJECT_NOT_FOUND', '项目不存在')
        if (latestProject.settlementInvoices?.some(invoice => invoice.assetId === asset.id)) {
          throw new AppError(409, 'INVOICE_ALREADY_CONFIRMED', '已确认结算的凭证不能删除')
        }
        await repositories.auditLogs.insert(auditRecord({
          actor: settlementOperator!.label, role: settlementOperator!.role,
          action: '删除待确认结算凭证', target: asset.id,
          before: { projectId, status: asset.status }, after: { status: 'pending_delete' }
        }) as never, session)
      })
      return send(res, 200, { message: '待确认发票及文件已删除' })
    } catch (error) {
      const latestAsset = await repositories.fileAssets.getById(asset.id)
      if (!latestAsset || latestAsset.status === 'pending_delete') {
        return send(res, 202, { message: '待确认发票已停用，存储文件待重试清理' })
      }
      ocrProofStore.restore(proof)
      throw error
    }
  }

  if (pathname === '/api/mcp/sync') {
    const result = await fetchAllProcurementPages({
      baseUrl: process.env.PROCUREMENT_API_URL ?? 'https://prod-api-admin.fushangyunfu.com/admin-api/erp/offline-order/page',
      token: process.env.PROCUREMENT_TOKEN ?? ''
    })
    let created = 0
    let updated = 0
    let skipped = 0
    const skippedByReason = {
      missingId: 0,
      missingTitle: 0,
      nonPositiveCost: 0,
      protectedUnchanged: 0
    }
    for (const order of result.items) {
      const skipReason = procurementOrderSkipReason(order)
      if (skipReason) {
        skippedByReason[skipReason] += 1
        skipped += 1
        continue
      }
      const mapped = mapProcurementOrderToProject(order)
      if (!mapped) {
        continue
      }

      const existing = projects.find(project => project.id === mapped.id)
      if (!existing) {
        projects.push(mapped)
        created += 1
        continue
      }

      const hasRule = Boolean(existing.ruleId) || rules.some(rule => rule.projectId === existing.id)
      const hasSubscription = subscriptions.some(subscription => subscription.projectId === existing.id)
      const mergeResult = mergeProcurementProject(existing, mapped, existing.status !== '未开放' || hasRule || hasSubscription)
      if (mergeResult === 'skipped') {
        skippedByReason.protectedUnchanged += 1
        skipped += 1
        continue
      }
      updated += 1
    }
    const summary = { fetched: result.fetched, total: result.total, created, updated, skipped, skippedByReason }
    await pushAudit({
      actor: manager!.label,
      role: manager!.role,
      action: '采购订单分页拉取',
      target: 'procurement-offline-order-page',
      before: null,
      after: summary
    })
    return send(res, 200, {
      data: summary,
      message: formatProcurementSyncMessage(summary)
    })
  }

  if (pathname === '/api/receiving-codes') {
    const actor = receivingCodeManager(req)
    const subject = String(body.subject ?? '').trim()
    const accountNote = String(body.accountNote ?? '').trim()
    const codeName = String(body.codeName ?? '').trim()
    const createRequestId = String(body.createRequestId ?? '').trim()
    if (!subject || !accountNote || !codeName) {
      return send(res, 400, { error: 'RECEIVING_CODE_FIELDS_REQUIRED', message: '请完整填写收款主体、账户说明和收款码名称' })
    }
    if (!createRequestId) {
      return send(res, 400, { error: 'RECEIVING_CODE_REQUEST_ID_REQUIRED', message: '缺少收款码创建请求标识，请重新打开创建窗口' })
    }
    const existing = await repositories.receivingCodes.findOne({ createRequestId } as never)
    if (!existing && await repositories.receivingCodes.count() >= maxReceivingCodes) {
      return send(res, 429, { error: 'RECEIVING_CODE_LIMIT_EXCEEDED', message: '收款码数量已达上限' })
    }
    const result = await createReceivingCodeOnce({
      createRequestId,
      subject,
      accountNote,
      codeName,
      operator: actor.label,
      role: actor.role
    }, {
      receivingCodes: repositories.receivingCodes,
      auditLogs: repositories.auditLogs,
      files: fileAssetService,
      mongo,
      idFactory: () => `RCV-${Date.now()}-${randomUUID().slice(0, 8)}`,
      auditIdFactory: () => `AUD-${Date.now()}-${randomUUID()}`,
      now
    })
    if (!receivingCodes.some(item => item.id === result.record.id)) receivingCodes.unshift(result.record as ReceivingCode)
    return send(res, result.created ? 201 : 200, {
      data: presentReceivingCode(result.record),
      message: result.created ? '收款码已创建并保存' : '重复请求已返回原收款码'
    })
  }

  const receivingCodeImageMatch = pathname.match(/^\/api\/receiving-codes\/([^/]+)\/image$/)
  if (receivingCodeImageMatch) {
    const actor = receivingCodeManager(req)
    const receivingCodeId = decodeURIComponent(receivingCodeImageMatch[1])
    const receivingCode = receivingCodes.find(item => item.id === receivingCodeId)
    if (!receivingCode) return send(res, 404, { error: 'RECEIVING_CODE_NOT_FOUND', message: '项目收款码不存在' })
    await requireReceivingCodeMutable(receivingCodeId)
    const image = validateImagePayload(body, res, 'RECEIVING_CODE')
    if (!image) return
    if (!ensureImageStorageCapacity(res, image.imageUrl, receivingCode.imageUrl ?? '')) return
    const before = { imageName: receivingCode.imageName, updatedBy: receivingCode.updatedBy, updatedAt: receivingCode.updatedAt }
    receivingCode.imageUrl = image.imageUrl
    receivingCode.imageName = image.imageName
    receivingCode.updatedBy = actor.label
    receivingCode.updatedAt = now()
    await pushAudit({
      actor: receivingCode.updatedBy,
      role: actor.role,
      action: before.imageName ? '更换收款码图片' : '上传收款码图片',
      target: receivingCode.id,
      before,
      after: { imageName: receivingCode.imageName, updatedBy: receivingCode.updatedBy, updatedAt: receivingCode.updatedAt }
    })
    return send(res, 200, { data: receivingCode, message: before.imageName ? '收款码图片已更换并保存' : '收款码图片已上传并保存' })
  }

  const receivingCodeDisableMatch = pathname.match(/^\/api\/receiving-codes\/([^/]+)\/disable$/)
  if (receivingCodeDisableMatch) {
    const actor = receivingCodeManager(req)
    const receivingCodeId = decodeURIComponent(receivingCodeDisableMatch[1])
    const receivingCode = receivingCodes.find(item => item.id === receivingCodeId)
    if (!receivingCode) return send(res, 404, { error: 'RECEIVING_CODE_NOT_FOUND', message: '项目收款码不存在' })
    const reason = String(body.reason ?? '').trim()
    if (!reason) return send(res, 400, { error: 'DISABLE_REASON_REQUIRED', message: '禁用收款码必须填写理由' })
    if (receivingCode.status === '已禁用') return send(res, 200, { data: receivingCode, message: '收款码已处于禁用状态' })
    const before = { status: receivingCode.status, disabledReason: receivingCode.disabledReason }
    receivingCode.status = '已禁用'
    receivingCode.disabledReason = reason
    receivingCode.updatedBy = actor.label
    receivingCode.updatedAt = now()
    await pushAudit({ actor: receivingCode.updatedBy, role: actor.role, action: '禁用收款码', target: receivingCode.id, before, after: { status: receivingCode.status, disabledReason: reason } })
    return send(res, 200, { data: receivingCode, message: '收款码已禁用并保存' })
  }

  if (pathname === '/api/subscriptions') {
    const context = requestContext(req)
    if (context.role !== 'employee' || (body.userId !== undefined && body.userId !== context.userId)) {
      throw new AppError(403, 'FORBIDDEN', '只能以本人身份认购')
    }
    const project = projects.find(item => item.id === body.projectId)
    let amount = Number(body.amount)
    if (!project) return send(res, 404, { error: 'PROJECT_NOT_FOUND', message: '项目不存在' })
    if (!body.idempotencyKey) return send(res, 400, { error: 'IDEMPOTENCY_KEY_REQUIRED', message: '缺少 idempotency_key（幂等键）' })
    const rule = rules.find(item => item.id === project.ruleId)
    const userId = context.userId
    const existing = subscriptions.find(item => item.idempotencyKey === body.idempotencyKey)
    if (existing) {
      const sameRequest = existing.projectId === project.id && existing.userId === userId && (rule?.sharePrice !== undefined
        ? existing.shares === Number(body.shares) && (body.amount === undefined || existing.amount === Number(body.amount))
        : existing.amount === Number(body.amount))
      if (!sameRequest) return send(res, 409, { error: 'IDEMPOTENCY_KEY_CONFLICT', message: '该幂等键已用于其他认购请求' })
      return send(res, 200, { data: existing, message: '重复请求已按幂等键返回原认购记录' })
    }
    if (body.agreementsConfirmed !== true) return send(res, 409, { error: 'AGREEMENT_REQUIRED', message: '请先确认当前有效协议' })
    await agreementService.requireCurrent(body.agreementVersion)
    if (project.status !== '未满额') return send(res, 409, { error: 'PROJECT_NOT_SUBSCRIBABLE', message: '只有未满额项目可以继续认购' })
    let shares: number | undefined
    if (rule?.sharePrice !== undefined) {
      const deadline = new Date(project.deadline.replace(' ', 'T')).getTime()
      if (!Number.isFinite(deadline) || Date.now() > deadline) return send(res, 409, { error: 'SUBSCRIPTION_DEADLINE_PASSED', message: '认购截止时间已过或无效' })
      const userSubscriptions = subscriptions.filter(item => item.projectId === project.id && item.userId === userId)
      if (!rule.allowMultiple && userSubscriptions.length > 0) return send(res, 409, { error: 'MULTIPLE_SUBSCRIPTIONS_DISABLED', message: '本项目不允许重复认购' })
      shares = Number(body.shares)
      try {
        amount = calculateShareSubscription(rule.sharePrice, shares, project.remain,
          userSubscriptions.reduce((sum, item) => sum + (item.shares ?? 0), 0), rule.maxSharesPerEmployee ?? 0)
      } catch (error) {
        return send(res, 400, { error: 'SHARE_SUBSCRIPTION_INVALID', message: error instanceof Error ? error.message : '认购份数无效' })
      }
      if (body.amount !== undefined && Number(body.amount) !== amount) return send(res, 400, { error: 'SHARE_AMOUNT_MISMATCH', message: '认购金额必须由份数和每份金额计算' })
    } else {
      if (typeof body.amount !== 'number' || !Number.isFinite(amount)) return send(res, 400, { error: 'AMOUNT_INVALID', message: '认购金额必须是有效数字' })
      if (amount < 100) return send(res, 400, { error: 'AMOUNT_TOO_SMALL', message: '认购金额不能低于 100 元' })
    }
    if (amount > project.remain) return send(res, 409, { error: 'INSUFFICIENT_REMAINING_AMOUNT', message: '剩余可认购金额不足' })

    const before = { subscribed: project.subscribed, remain: project.remain, people: project.people, employeeSubscribedAmount: project.employeeSubscribedAmount }
    const nextProject = { ...project, employeeSubscribedAmount: project.employeeSubscribedAmount + amount, people: project.people + 1 }
    normalizeProjectAmounts(nextProject)
    if (nextProject.remain <= 0 || nextProject.progress >= 100) {
      nextProject.status = '已满额'
      nextProject.statusType = 'success'
    }

    const createdAt = now()
    const record: Subscription = {
      id: `SUB-${Date.now()}`,
      projectId: project.id,
      project: project.title,
      userId,
      userName: iamDisplayName(req),
      amount,
      shares,
      pay: '未缴款',
      profit: project.profitAmount,
      action: '去支付',
      idempotencyKey: String(body.idempotencyKey),
      agreementVersion: Number(body.agreementVersion),
      createdAt,
      paymentDeadlineAt: rule?.sharePrice && rule.paymentCutoffAt
        ? employeePaymentDeadline(createdAt, rule.paymentCutoffAt)
        : addHours(createdAt, 12)
    }
    const audit = auditRecord({ actor: `${record.userId} · 员工`, role: 'employee', action: '创建认购', target: record.id, before, after: { subscribed: nextProject.subscribed, remain: nextProject.remain, subscription: record.id, agreementVersion: record.agreementVersion } }) as AuditLog
    await mongo.withTransaction(async session => {
      await agreementService.requireCurrent(body.agreementVersion, session)
      const latest = await repositories.projects.getById(project.id, session)
      if (!latest || latest.remain !== before.remain || latest.people !== before.people) throw new AppError(409, 'PROJECT_CHANGED', '项目认购额度已变化，请刷新后重试')
      await repositories.projects.replace(nextProject, session)
      await repositories.subscriptions.insert(record, session)
      await repositories.auditLogs.insert(audit as never, session)
      await agreementService.confirm({ version: record.agreementVersion!, userId, userName: record.userName!, node: '提交认购', relatedId: record.id }, session)
      return true
    })
    Object.assign(project, nextProject)
    subscriptions.unshift(record)
    auditLogs.unshift(audit)
    return send(res, 201, { data: record })
  }

  const receiptMatch = pathname.match(/^\/api\/subscriptions\/([^/]+)\/confirm-receipt$/)
  if (receiptMatch) {
    const subscriptionId = decodeURIComponent(receiptMatch[1])
    const subscription = subscriptions.find(item => item.id === subscriptionId)
    if (!subscription) return send(res, 404, { error: 'SUBSCRIPTION_NOT_FOUND', message: '认购记录不存在' })
    const context = requestContext(req)
    if (context.role !== 'employee' || subscription.userId !== context.userId) throw new AppError(403, 'FORBIDDEN', '只能确认本人认购的收款')
    if (subscription.pay !== '待确认收款') {
      return send(res, 409, { error: 'SUBSCRIPTION_STATUS_INVALID', message: '仅待确认收款状态可以确认收款' })
    }
    if (body.agreementsConfirmed !== true) return send(res, 409, { error: 'AGREEMENT_REQUIRED', message: '请先确认当前有效协议' })
    const agreement = await agreementService.requireCurrent(body.agreementVersion)
    const before = { pay: subscription.pay, action: subscription.action }
    const updated = { ...subscription, pay: '已收款' as const, action: '查看支付', receiptAgreementVersion: agreement.version }
    const audit = auditRecord({
      actor: `${context.userId} · 员工`,
      role: 'employee',
      action: '确认收款',
      target: subscription.id,
      before,
      after: { pay: updated.pay, action: updated.action, agreementVersion: agreement.version },
      result: '成功'
    }) as AuditLog
    await mongo.withTransaction(async session => {
      await agreementService.requireCurrent(agreement.version, session)
      const latest = await repositories.subscriptions.getById(subscription.id, session)
      if (!latest || latest.pay !== '待确认收款') throw new AppError(409, 'SUBSCRIPTION_STATUS_INVALID', '认购状态已变化，请刷新后重试')
      await repositories.subscriptions.replace(updated, session)
      await repositories.auditLogs.insert(audit as never, session)
      await agreementService.confirm({ version: agreement.version, userId: context.userId, userName: iamDisplayName(req), node: '确认收款', relatedId: subscription.id }, session)
      return true
    })
    Object.assign(subscription, updated)
    auditLogs.unshift(audit)
    return send(res, 200, { data: updated, message: '已确认收款，状态已更新为已收款' })
  }

  const reviewMatch = pathname.match(/^\/api\/subscriptions\/([^/]+)\/review$/)
  if (reviewMatch) {
    const context = requestContext(req)
    if (context.role !== 'finance') throw new AppError(403, 'FORBIDDEN', '只有财务可以复核支付')
    const subscriptionId = decodeURIComponent(reviewMatch[1])
    const subscription = subscriptions.find(item => item.id === subscriptionId)
    if (!subscription) return send(res, 404, { error: 'SUBSCRIPTION_NOT_FOUND', message: '认购记录不存在' })
    if ((await repositories.projects.getById(subscription.projectId))?.purchasePaymentId) return send(res, 409, { error: 'SUBSCRIPTION_LOCKED', message: '采购付款登记后认购单已锁定' })
    if (subscription.pay !== '待复核') {
      return send(res, 409, { error: 'SUBSCRIPTION_STATUS_INVALID', message: '仅待复核状态可以执行复核' })
    }
    const result = body.result as 'pass' | 'reject' | 'partial'
    const nextPay = result === 'pass' ? '已缴款' : result === 'reject' ? '复核驳回' : result === 'partial' ? '部分缴款' : ''
    if (!nextPay) return send(res, 400, { error: 'REVIEW_RESULT_INVALID', message: '复核结果不合法' })
    const rejectReason = String(body.rejectReason ?? '').trim()
    if (result === 'reject' && !rejectReason) {
      return send(res, 400, { error: 'REJECT_REASON_REQUIRED', message: '复核驳回必须填写驳回理由' })
    }
    const reviewedAt = now()
    const reviewedBy = `${context.userId} · 财务`
    if (subscription.shares !== undefined && result === 'pass') {
      try {
        const updated = await mongo.withTransaction(async session => {
          const latest = await repositories.subscriptions.getById(subscription.id, session)
          if (!latest || latest.pay !== '待复核' || latest.shares === undefined) throw new AppError(409, 'SUBSCRIPTION_STATUS_INVALID', '认购状态已变化，请刷新后重试')
          if ((await repositories.projects.getById(latest.projectId, session))?.purchasePaymentId) throw new AppError(409, 'SUBSCRIPTION_LOCKED', '采购付款登记后认购单已锁定')
          const verified = validateContributionReview({
            expectedAmount: latest.amount,
            actualPaidAmount: Number(body.actualPaidAmount),
            transactionNo: String(body.transactionNo ?? ''),
            proofs: latest.paymentImages ?? []
          })
          for (const assetId of verified.proofAssetIds) {
            const asset = await repositories.fileAssets.getById(assetId, session)
            if (!asset || asset.status !== 'ready' || asset.purpose !== 'payment-proof' || asset.ownerType !== 'subscription' || asset.ownerId !== latest.id) {
              throw new AppError(409, 'PAYMENT_PROOF_INVALID', '缴款凭证不存在或未完成留存')
            }
          }
          const record = {
            ...latest, pay: '已缴款' as const, action: '查看支付', reviewedBy, reviewedAt,
            rejectReason: undefined, actualPaidAmount: verified.amountCents / 100, transactionNo: verified.transactionNo
          }
          await repositories.subscriptions.replace(record, session)
          if (await mongo.db.collection(`${appConfig.mongodb.collectionPrefix}fund_ledger`).findOne({ transactionNo: verified.transactionNo }, { session })) {
            throw new AppError(409, 'BANK_TRANSACTION_DUPLICATE', '该银行流水号已被使用')
          }
          await bankTransactions.insertOne({ transactionNo: verified.transactionNo, sourceKey: `contribution:${latest.id}`,
            projectId: latest.projectId, createdAt: reviewedAt }, { session })
          await fundLedger.append({
            id: `LED-${randomUUID()}`, sourceKey: `contribution:${latest.id}`, type: 'employee_contribution',
            projectId: latest.projectId, subscriptionId: latest.id, participantId: latest.userId,
            shares: latest.shares, amountCents: verified.amountCents, transactionNo: verified.transactionNo,
            transactionKey: JSON.stringify([latest.projectId, 'employee_contribution', verified.transactionNo]),
            proofAssetIds: verified.proofAssetIds, reviewedBy, createdAt: reviewedAt
          }, session)
          await repositories.auditLogs.insert(auditRecord({
            actor: reviewedBy, role: 'finance', action: '按份认购缴款复核通过', target: latest.id,
            before: { pay: latest.pay }, after: { pay: record.pay, amountCents: verified.amountCents, transactionNo: verified.transactionNo }
          }) as never, session)
          return record
        })
        const index = subscriptions.findIndex(item => item.id === updated.id)
        if (index >= 0) subscriptions.splice(index, 1, updated as Subscription)
        return send(res, 200, { data: updated, message: '财务复核通过，缴款流水已追加到资金台账' })
      } catch (error) {
        if (error instanceof AppError) return send(res, error.status, { error: error.code, message: error.message })
        if (error instanceof RangeError) return send(res, 400, { error: 'CONTRIBUTION_REVIEW_MISMATCH', message: error.message })
        if (isDuplicateKey(error)) return send(res, 409, { error: 'LEDGER_TRANSACTION_DUPLICATE', message: '该交易流水号或认购复核记录已存在' })
        throw error
      }
    }
    const before = {
      pay: subscription.pay,
      action: subscription.action,
      reviewedBy: subscription.reviewedBy,
      reviewedAt: subscription.reviewedAt,
      rejectReason: subscription.rejectReason
    }
    subscription.pay = nextPay
    subscription.action = result === 'reject' ? '重新上传截图' : '查看支付'
    subscription.reviewedBy = reviewedBy
    subscription.reviewedAt = reviewedAt
    subscription.rejectReason = result === 'reject' ? rejectReason : undefined
    await pushAudit({
      actor: subscription.reviewedBy,
      role: 'finance',
      action: result === 'pass' ? '支付复核 · 通过' : result === 'reject' ? '支付复核 · 驳回' : '支付复核 · 标记部分缴款',
      target: subscription.id,
      before,
      after: {
        pay: subscription.pay,
        action: subscription.action,
        reviewedBy: subscription.reviewedBy,
        reviewedAt: subscription.reviewedAt,
        rejectReason: subscription.rejectReason
      },
      result: '成功'
    })
    await persistState()
    const message = result === 'pass' ? '复核通过，员工缴款状态已更新为缴款成功' : result === 'reject' ? '复核驳回，员工缴款状态已更新为缴款被驳回' : '已标记部分缴款，并记录复核人员与操作时间'
    return send(res, 200, { data: subscription, message })
  }

  if (pathname === '/api/rules') {
    requireAdminDraftProject(req, body.projectId)
    const validated = validateRulePayload(body, res)
    if (!validated) return
    const { project, totalAmount, companyFixedAmount, minAmount, minParticipants, receivingCodeId, shareRule } = validated
    if (rules.some(rule => rule.projectId === project.id)) {
      return send(res, 409, {
        error: 'PROJECT_RULE_EXISTS',
        message: '该项目已存在认购规则，请直接修改原规则。'
      })
    }
    const hasRealSubscriptions = hasRealUserSubscriptions(project.id)
    if (hasRealSubscriptions) {
      return send(res, 409, {
        error: 'OPEN_PROJECT_RULE_LOCKED',
        message: '该项目已开放认购且已有真实用户认购记录，不支持修改规则配置内容。'
      })
    }
    const record: SubscriptionRule = {
      id: `RULE-${Date.now()}`,
      projectId: project.id,
      projectName: project.title,
      ...ownershipFrom(iamContextFor(req)),
      ruleName: String(body.ruleName).trim(),
      totalAmount,
      ...shareRule,
      companyFixedAmount,
      minAmount,
      minParticipants,
      receivingCodeId,
      allowMultiple: Boolean(body.allowMultiple),
      companyTakeover: shareRule ? true : Boolean(body.companyTakeover),
      status: normalizeRuleStatus(body.status),
      startAt: typeof body.startAt === 'string' ? body.startAt : '',
      endAt: typeof body.endAt === 'string' ? body.endAt : '',
      paymentCutoffAt: shareRule ? String(body.paymentCutoffAt) : undefined,
      plannedPaymentDate: shareRule ? String(body.plannedPaymentDate) : undefined,
      updatedAt: now()
    }
    rules.unshift(record)
    await pushAudit({ actor: manager!.label, role: manager!.role, action: '创建认购规则', target: record.id, before: null, after: record })
    await persistState()
    return send(res, 201, { data: record })
  }

  if (pathname.startsWith('/api/rules/') && pathname.endsWith('/update')) {
    const ruleId = pathname.split('/')[3]
    const rule = rules.find(item => item.id === ruleId)
    if (!rule) return send(res, 404, { error: 'RULE_NOT_FOUND', message: '认购规则不存在' })
    requireAdminOwned(req, rule)
    requireAdminDraftProject(req, body.projectId)
    if (isRuleLocked(rule.id)) {
      return send(res, 409, {
        error: 'RULE_LOCKED_BY_SUBSCRIPTION',
        message: '该规则已被有真实认购记录的项目使用，不支持修改规则配置内容。'
      })
    }
    const validated = validateRulePayload(body, res)
    if (!validated) return
    const { project, totalAmount, companyFixedAmount, minAmount, minParticipants, receivingCodeId, shareRule } = validated
    if (rules.some(item => item.projectId === project.id && item.id !== rule.id)) {
      return send(res, 409, { error: 'PROJECT_RULE_EXISTS', message: '该项目已有认购规则' })
    }
    const nextStatus = normalizeRuleStatus(body.status ?? rule.status)
    const hasRealSubscriptions = hasRealUserSubscriptions(project.id)
    if (nextStatus === '已启用' && hasRealSubscriptions) {
      return send(res, 409, {
        error: 'OPEN_PROJECT_RULE_LOCKED',
        message: '该项目已开放认购且已有真实用户认购记录，不支持修改规则配置内容。'
      })
    }
    const before = { ...rule }
    rule.projectId = project.id
    rule.projectName = project.title
    rule.ruleName = String(body.ruleName)
    rule.totalAmount = totalAmount
    rule.sharePrice = shareRule?.sharePrice
    rule.totalShares = shareRule?.totalShares
    rule.companyFrontShares = shareRule?.companyFrontShares
    rule.maxSharesPerEmployee = shareRule?.maxSharesPerEmployee
    rule.companyFixedAmount = companyFixedAmount
    rule.minAmount = minAmount
    rule.minParticipants = minParticipants
    rule.receivingCodeId = receivingCodeId
    rule.allowMultiple = Boolean(body.allowMultiple)
    rule.companyTakeover = shareRule ? true : Boolean(body.companyTakeover)
    rule.status = nextStatus
    rule.startAt = String(body.startAt ?? '')
    rule.endAt = String(body.endAt ?? '')
    rule.paymentCutoffAt = shareRule ? String(body.paymentCutoffAt) : undefined
    rule.plannedPaymentDate = shareRule ? String(body.plannedPaymentDate) : undefined
    rule.updatedAt = now()
    await pushAudit({ actor: manager!.label, role: manager!.role, action: '修改认购规则', target: rule.id, before, after: rule })
    await persistState()
    return send(res, 200, { data: rule, message: '认购规则已修改' })
  }

  if (pathname.startsWith('/api/rules/') && pathname.endsWith('/status')) {
    const ruleId = pathname.split('/')[3]
    const rule = rules.find(item => item.id === ruleId)
    if (!rule) return send(res, 404, { error: 'RULE_NOT_FOUND', message: '认购规则不存在' })
    requireAdminOwned(req, rule)
    requireAdminDraftProject(req, rule.projectId)
    const nextStatus = normalizeRuleStatus(body.status)
    if (nextStatus === '未启用') {
      return send(res, 400, { error: 'RULE_STATUS_INVALID', message: '规则状态仅支持启用或停用' })
    }
    if (nextStatus === '已启用' && rule.status !== '未启用') {
      return send(res, 400, { error: 'RULE_STATUS_INVALID', message: '仅未启用状态的认购规则支持启用' })
    }
    if (nextStatus === '已停用' && rule.status !== '已启用') {
      return send(res, 400, { error: 'RULE_STATUS_INVALID', message: '仅已启用状态的认购规则支持停用' })
    }
    if (nextStatus === '已停用' && isRuleLocked(rule.id)) {
      return send(res, 409, {
        error: 'RULE_LOCKED_BY_SUBSCRIPTION',
        message: '该规则已被有真实认购记录的项目使用，不支持停用。'
      })
    }
    const before = { ...rule }
    rule.status = nextStatus
    rule.updatedAt = now()
    await pushAudit({ actor: manager!.label, role: manager!.role, action: nextStatus === '已启用' ? '启用认购规则' : '停用认购规则', target: rule.id, before, after: rule })
    await persistState()
    return send(res, 200, { data: rule, message: nextStatus === '已启用' ? '认购规则已启用' : '认购规则已停用' })
  }

  if (pathname.startsWith('/api/rules/') && pathname.endsWith('/delete')) {
    const ruleId = pathname.split('/')[3]
    const index = rules.findIndex(item => item.id === ruleId)
    if (index < 0) return send(res, 404, { error: 'RULE_NOT_FOUND', message: '认购规则不存在' })
    const rule = rules[index]
    requireAdminOwned(req, rule)
    requireAdminDraftProject(req, rule.projectId)
    if (isRuleLocked(rule.id)) {
      return send(res, 409, {
        error: 'RULE_LOCKED_BY_SUBSCRIPTION',
        message: '该规则已被有真实认购记录的项目使用，不支持删除。'
      })
    }
    await mongo.withTransaction(async session => {
      await repositories.rules.deleteById(rule.id, session)
      await repositories.auditLogs.insert(auditRecord({
        actor: manager!.label,
        role: manager!.role, action: '删除认购规则', target: rule.id, before: rule, after: null
      }) as never, session)
      return true
    })
    rules.splice(index, 1)
    return send(res, 200, { message: '认购规则已删除' })
  }

  if (pathname.startsWith('/api/projects/') && pathname.endsWith('/open')) {
    const projectId = pathname.split('/')[3]
    const project = projects.find(item => item.id === projectId)
    if (!project) return send(res, 404, { error: 'PROJECT_NOT_FOUND', message: '项目不存在' })
    if (project.status !== '未开放') {
      return send(res, 409, { error: 'PROJECT_STATUS_INVALID', message: '只有未开放项目可以开放认购' })
    }
    const ruleId = String(body.ruleId ?? '')
    if (!ruleId) {
      return send(res, 400, { error: 'RULE_REQUIRED', message: '请选择认购规则配置后再开放项目' })
    }
    const selectedRule = rules.find(rule => rule.id === ruleId)
    if (!selectedRule) {
      return send(res, 404, { error: 'RULE_NOT_FOUND', message: '认购规则不存在' })
    }
    requireAdminOwned(req, selectedRule)
    if (selectedRule.projectId !== project.id) {
      return send(res, 409, { error: 'RULE_PROJECT_MISMATCH', message: '开放认购前必须选择当前项目归属的认购规则' })
    }
    if (selectedRule.status !== '已启用') {
      return send(res, 409, { error: 'RULE_NOT_ENABLED', message: '开放认购前必须先启用当前项目归属的认购规则' })
    }
    if (project.salesAmount <= project.costAmount) {
      return send(res, 409, { error: 'PROJECT_MARGIN_INVALID', message: '销售金额不高于采购金额，无法发布众筹' })
    }
    let shareRule: ReturnType<typeof prepareShareRule>
    try {
      shareRule = prepareShareRule(project.costAmount, selectedRule.sharePrice ?? NaN,
        selectedRule.companyFrontShares ?? NaN, selectedRule.maxSharesPerEmployee)
    } catch {
      return send(res, 409, { error: 'SHARE_RULE_INVALID', message: '发布前须配置有效的按份认购规则' })
    }
    if (selectedRule.totalAmount !== shareRule.totalAmount || selectedRule.companyFixedAmount !== shareRule.companyFixedAmount
      || selectedRule.totalShares !== shareRule.totalShares
      || selectedRule.maxSharesPerEmployee !== shareRule.maxSharesPerEmployee) {
      return send(res, 409, { error: 'SHARE_RULE_CHANGED', message: '份额规则与采购金额不一致，请重新配置' })
    }
    try {
      validatePublishSchedule({ subscriptionCutoffAt: selectedRule.endAt,
        paymentCutoffAt: selectedRule.paymentCutoffAt, plannedPaymentDate: selectedRule.plannedPaymentDate })
    } catch (error) {
      return send(res, 409, { error: 'PUBLISH_SCHEDULE_INVALID', message: error instanceof Error ? error.message : '发布时间安排无效' })
    }
    const publisher = ownershipFrom(iamContextFor(req))
    const result = await mongo.withTransaction(async session => {
      const latest = await repositories.projects.getById(project.id, session)
      const latestRule = await repositories.rules.getById(selectedRule.id, session)
      if (!latest || latest.status !== '未开放' || !latestRule || latestRule.updatedAt !== selectedRule.updatedAt
        || latestRule.status !== '已启用' || latestRule.projectId !== latest.id
        || latest.costAmount !== project.costAmount || latest.salesAmount !== project.salesAmount
        || (['sharePrice', 'totalShares', 'companyFrontShares', 'maxSharesPerEmployee', 'companyFixedAmount',
          'totalAmount', 'endAt', 'paymentCutoffAt', 'plannedPaymentDate', 'receivingCodeId'] as const).some(field => latestRule[field] !== selectedRule[field])) {
        throw new AppError(409, 'PROJECT_CHANGED', '采购项目或规则已变化，请刷新后重试')
      }
      const updated = { ...latest, ruleId: latestRule.id, ...publisher,
        total: shareRule.totalAmount, companyFixedAmount: shareRule.companyFixedAmount,
        deadline: latestRule.endAt, status: '未满额' as const, statusType: 'primary' as const,
        interruptReason: undefined, interruptedAt: undefined, refundNotice: undefined }
      normalizeProjectAmounts(updated as Project)
      const companyRecord: Subscription | undefined = shareRule.companyFrontShares > 0 ? {
        id: `SUB-COMPANY-FRONT-${updated.id}`, projectId: updated.id, project: updated.title,
        userId: 'company', companyKind: 'front', amount: shareRule.companyFixedAmount,
        shares: shareRule.companyFrontShares, pay: '公司待出资', profit: updated.profitAmount,
        action: '财务确认公司出资', idempotencyKey: `system:company-front:${updated.id}`,
        createdAt: now(), paymentDeadlineAt: latestRule.paymentCutoffAt!
      } : undefined
      const audit = auditRecord({ actor: manager!.label, role: manager!.role, action: '开放项目认购',
        target: updated.id, before: { status: latest.status, total: latest.total, deadline: latest.deadline, ruleId: latest.ruleId },
        after: { status: updated.status, total: updated.total, deadline: updated.deadline,
          ruleId: latestRule.id, ruleName: latestRule.ruleName, publisher, companyFrontShares: shareRule.companyFrontShares } })
      await repositories.projects.replace(updated, session)
      if (companyRecord) await repositories.subscriptions.insert(companyRecord, session)
      await repositories.auditLogs.insert(audit as never, session)
      return { updated, companyRecord, audit }
    }).catch(error => {
      if (isDuplicateKey(error)) throw new AppError(409, 'PROJECT_PUBLISH_CONFLICT', '项目发布记录已存在，请刷新后重试')
      throw error
    })
    const index = projects.findIndex(item => item.id === result.updated.id)
    if (index >= 0) projects.splice(index, 1, result.updated as Project)
    if (result.companyRecord) subscriptions.unshift(result.companyRecord)
    auditLogs.unshift(result.audit as AuditLog)
    return send(res, 200, { data: result.updated, message: `项目已按「${selectedRule.ruleName}」开放，状态为未满额` })
  }

  if (pathname.startsWith('/api/projects/') && pathname.endsWith('/terminate')) {
    const projectId = pathname.split('/')[3]
    const project = projects.find(item => item.id === projectId)
    if (!project) return send(res, 404, { error: 'PROJECT_NOT_FOUND', message: '项目不存在' })
    requireAdminOwned(req, project)
    if (project.status !== '未开放') {
      return send(res, 409, { error: 'PROJECT_CLOSE_REQUIRED', message: '已发布众筹单请使用关闭及退款流程' })
    }
    const before = { status: project.status, remain: project.remain }
    project.status = '已中断'
    project.statusType = 'danger'
    project.interruptReason = '管理端终止认购'
    project.interruptedAt = now()
    project.refundNotice = undefined
    await pushAudit({
      actor: manager!.label,
      role: manager!.role,
      action: '终止项目认购',
      target: project.id,
      before,
      after: {
        status: project.status,
        interruptReason: project.interruptReason,
        refundNotice: project.refundNotice
      }
    })
    await persistState()
    return send(res, 200, { data: project, message: '未开放项目已停止' })
  }

  if (pathname.startsWith('/api/projects/') && pathname.endsWith('/interrupt')) {
    const projectId = pathname.split('/')[3]
    const project = projects.find(item => item.id === projectId)
    const reason = String(body.reason ?? '').trim()
    if (!project) return send(res, 404, { error: 'PROJECT_NOT_FOUND', message: '项目不存在' })
    requireAdminOwned(req, project)
    if (!reason) return send(res, 400, { error: 'INTERRUPT_REASON_REQUIRED', message: '中断认购必须填写中断原因' })
    return send(res, 409, { error: 'PROJECT_CLOSE_REQUIRED', message: '已发布众筹单请使用关闭及退款流程' })
  }

  if (pathname === '/api/payments/images/delete') {
    const subscription = await repositories.subscriptions.getById(String(body.subscriptionId ?? ''))
    if (!subscription) {
      return send(res, 404, { error: 'SUBSCRIPTION_NOT_FOUND', message: '认购记录不存在' })
    }
    if ((await repositories.projects.getById(subscription.projectId))?.purchasePaymentId) return send(res, 409, { error: 'SUBSCRIPTION_LOCKED', message: '采购付款登记后认购单已锁定' })
    const context = requestContext(req)
    if (context.role !== 'employee' || subscription.userId !== context.userId) throw new AppError(403, 'FORBIDDEN', '只能删除本人认购的支付截图')
    const imageId = typeof body.imageId === 'string' ? body.imageId.trim() : ''
    const imageIndex = subscription.paymentImages?.findIndex(item => item.id === imageId) ?? -1
    if (imageIndex < 0) {
      return send(res, 404, { error: 'PAYMENT_IMAGE_NOT_FOUND', message: '支付截图不存在' })
    }
    const image = subscription.paymentImages![imageIndex]
    if (image.status !== '识别失败') {
      return send(res, 409, { error: 'PAYMENT_IMAGE_DELETE_FORBIDDEN', message: '仅识别失败的支付截图支持删除' })
    }
    const updated = await fileAssetService.deleteBinding(image.assetId, async (_asset, session) => {
      const latest = await repositories.subscriptions.getById(subscription.id, session)
      if (!latest) throw new Error('认购记录不存在')
      if ((await repositories.projects.getById(latest.projectId, session))?.purchasePaymentId) throw new AppError(409, 'SUBSCRIPTION_LOCKED', '采购付款登记后认购单已锁定')
      const remainingImages = (latest.paymentImages ?? []).filter(item => item.id !== imageId)
      const latestImage = remainingImages.at(-1)
      const recognizedTotal = Number(remainingImages.filter(item => item.status === '已识别').reduce((sum, item) => sum + item.recognizedAmount, 0).toFixed(2))
      const hasFailedImage = remainingImages.some(item => item.status === '识别失败')
      const pay: PaymentStatus = latest.shares !== undefined
        ? remainingImages.length === 0 ? '未缴款' : '待复核'
        : hasFailedImage ? '待复核' : recognizedTotal === 0 ? '未缴款' : recognizedTotal < latest.amount ? '部分缴款' : '待复核'
      const record = {
        ...latest,
        paymentImages: remainingImages,
        paymentImageName: latestImage?.paymentImageName,
        paymentUploadedAt: latestImage?.uploadedAt,
        paymentSuccessAt: [...remainingImages].reverse().find(item => item.status === '已识别')?.uploadedAt,
        recognizedPaidAmount: recognizedTotal,
        pay,
        action: pay === '未缴款' ? '去支付' : recognizedTotal === latest.amount && !hasFailedImage ? '查看支付' : '重新上传截图'
      }
      await repositories.subscriptions.replace(record, session)
      await repositories.auditLogs.insert(auditRecord({
        actor: `${context.userId} · 员工`,
        role: 'employee',
        action: '删除识别失败支付截图',
        target: image.id,
        before: { assetId: image.assetId, status: image.status },
        after: null
      }) as never, session)
      return record
    })
    const localIndex = subscriptions.findIndex(item => item.id === updated.id)
    if (localIndex >= 0) subscriptions.splice(localIndex, 1, updated as Subscription)
    return send(res, 200, {
      data: {
        status: updated.pay,
        recognized_total: updated.recognizedPaidAmount ?? 0,
        remaining_amount: Math.max(0, Number((updated.amount - Number(updated.recognizedPaidAmount ?? 0)).toFixed(2))),
        image_count: updated.paymentImages?.length ?? 0
      },
      message: '识别失败的支付截图已删除'
    })
  }

  if (pathname === '/api/settlements/calc') {
    try {
      const requiredNumber = (value: unknown) => {
        if (typeof value !== 'number') throw new RangeError('所有金额必须明确填写为整数分')
        return value
      }
      return send(res, 200, { data: calculateSettlementProfit({
        receivableCents: requiredNumber(body.receivableCents),
        customerReceiptsCents: requiredNumber(body.customerReceiptsCents),
        companyTopUpsCents: requiredNumber(body.companyTopUpsCents),
        companyReturnsCents: requiredNumber(body.companyReturnsCents),
        procurementPaymentsCents: requiredNumber(body.procurementPaymentsCents),
        confirmedCostsCents: requiredNumber(body.confirmedCostsCents)
      }) })
    } catch (error) {
      return send(res, 400, { error: 'SETTLEMENT_PROFIT_INPUT_INVALID', message: error instanceof Error ? error.message : '试算金额无效' })
    }
  }

  const settlementConfirmMatch = pathname.match(/^\/api\/projects\/([^/]+)\/settlements\/confirm$/)
  if (settlementConfirmMatch) {
    const projectId = decodeURIComponent(settlementConfirmMatch[1])
    const project = await repositories.projects.getById(projectId) as Project | null
    if (!project) return send(res, 404, { error: 'PROJECT_NOT_FOUND', message: '项目不存在' })
    const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : ''
    const duplicateInvoice = project.settlementInvoices?.find(invoice => invoice.id === idempotencyKey)
    if (!duplicateInvoice && (project.settlementInvoices?.length ?? 0) >= maxSettlementInvoicesPerProject) {
      return send(res, 429, { error: 'SETTLEMENT_INVOICE_LIMIT_EXCEEDED', message: `每个项目最多保留 ${maxSettlementInvoicesPerProject} 条结算凭证` })
    }
    const proofId = typeof body.settlementProofId === 'string' ? body.settlementProofId.trim() : ''
    const assetId = duplicateInvoice?.assetId ?? (typeof body.assetId === 'string' ? body.assetId.trim() : '')
    const asset = await fileAssetService.getReadyAsset(assetId)
    if (!asset || asset.purpose !== 'settlement-invoice' || asset.ownerType !== 'project' || asset.ownerId !== projectId) {
      return send(res, 404, { error: 'FILE_NOT_FOUND', message: '结算图片资产不存在或不属于当前项目' })
    }
    const before = {
      status: project.status,
      settledAmount: Number(project.settledAmount ?? 0),
      remainingAmount: Number((project.salesAmount - Number(project.settledAmount ?? 0)).toFixed(2))
    }
    try {
      const trustedProof = duplicateInvoice ? null : ocrProofStore.consume({
        proofId,
        projectId,
        assetId: asset.id,
        imageDigest: asset.sha256,
        fileName: asset.originalName
      })
      const trustedResult = trustedProof?.result
      const trustedField = (key: string) => trustedResult?.fields.find(field => field.key === key)?.value ?? '未识别'
      const result = confirmProjectSettlement(project, {
        idempotencyKey,
        amount: duplicateInvoice?.amount ?? Number(trustedResult?.amount),
        fileName: asset.originalName,
        assetId: asset.id,
        transactionDate: duplicateInvoice?.transactionDate ?? trustedField('transactionDate'),
        payer: duplicateInvoice?.payer ?? trustedField('payer'),
        payee: duplicateInvoice?.payee ?? trustedField('payee'),
        operator: settlementOperator!.label
      }, now())
      await mongo.withTransaction(async session => {
        await repositories.projects.replace(project as never, session)
        await repositories.auditLogs.insert(auditRecord({
          actor: settlementOperator!.label,
          role: settlementOperator!.role,
          action: result.duplicate ? '重复确认凭证（幂等命中）' : '确认发票凭证',
          target: project.id,
          before,
          after: {
            status: project.status,
            settledAmount: result.settledAmount,
            remainingAmount: result.remainingAmount,
            invoiceId: result.invoice.id,
            invoiceAmount: result.invoice.amount,
            assetId: asset.id
          }
        }) as never, session)
        return true
      })
      const localIndex = projects.findIndex(item => item.id === project.id)
      if (localIndex >= 0) projects.splice(localIndex, 1, project)
      return send(res, 200, {
        data: { project, ...result },
        message: result.canUploadMore ? '发票凭证已记录，可继续核对其他凭证；未确认客户回款或完成分配' : '发票凭证金额已达到预计销售额；未确认客户回款或完成分配'
      })
    } catch (error) {
      const baseMessage = error instanceof Error ? error.message : '确认结算失败'
      const message = !duplicateInvoice && !baseMessage.includes('OCR 凭证')
        ? `${baseMessage}；OCR 凭证已消耗，请重新识别后再确认`
        : baseMessage
      const status = message.includes('超过') || message.includes('已完结') || message.includes('当前状态') || message.includes('OCR 凭证') ? 409 : 400
      return send(res, status, { error: 'PROJECT_SETTLEMENT_CONFIRM_FAILED', message })
    }
  }

  if (pathname.startsWith('/api/takeovers/') && pathname.endsWith('/force')) {
    const projectId = pathname.split('/')[3]
    const project = projects.find(item => item.id === projectId)
    if (!project) return send(res, 404, { error: 'PROJECT_NOT_FOUND', message: '项目不存在' })
    if (project.status !== '未满额') {
      return send(res, 409, { error: 'PROJECT_NOT_FORCE_TAKEOVERABLE', message: '公司强制接管仅支持项目认购未满额阶段' })
    }
    const unpaidAmount = subscriptions
      .filter(item => item.projectId === project.id && item.pay === '未缴款')
      .reduce((sum, item) => sum + item.amount, 0)
    const forceAmount = project.remain
    if (forceAmount <= 0) {
      return send(res, 409, { error: 'NO_REMAINING_AMOUNT', message: '项目无剩余可认购金额，不能强制接管' })
    }
    const before = {
      status: project.status,
      remain: project.remain,
      companyFixedAmount: project.companyFixedAmount,
      companyTakeoverAmount: project.companyTakeoverAmount,
      companyForcedTakeoverAmount: project.companyForcedTakeoverAmount,
      unpaidEmployeeSubscribedAmount: unpaidAmount
    }
    project.status = '已满额'
    project.statusType = 'success'
    project.companyForcedTakeoverAmount += forceAmount
    normalizeProjectAmounts(project)
    await pushAudit({
      actor: manager!.label,
      role: manager!.role,
      action: '强制接管',
      target: project.id,
      before,
      after: {
        status: project.status,
        remain: project.remain,
        companyForcedTakeoverAmount: project.companyForcedTakeoverAmount,
        companyTotalSubscribedAmount: project.companyFixedAmount + project.companyTakeoverAmount + project.companyForcedTakeoverAmount,
        note: '强制接管仅覆盖项目剩余可认购金额，不接管员工已认购未缴款金额；认购释放后才会重新进入剩余额度'
      }
    })
    await persistState()
    return send(res, 200, { data: project, message: '强制接管成功：仅接管剩余可认购金额，未接管员工已认购未缴款金额' })
  }

  return send(res, 404, { error: 'NOT_FOUND', message: '接口不存在' })
}

const server = createServer(observeRequests(async (req, res) => {
  if (!req.url) return send(res, 400, { error: 'BAD_REQUEST' })
  const url = new URL(req.url, 'http://127.0.0.1:4100')
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return await routeGet(url, req, res)
    if (handleCorsPreflight(req, res, iamConfig.allowedOrigin)) return
    if (await handleAuthRoute(req, res, url, { config: iamConfig, iam })) return
    if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' })
    let reviewPermission: ReturnType<typeof validateReviewAction> | undefined
    if (req.method === 'POST') {
      const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
      const raw = await readRawBody(req, contentType.startsWith('multipart/form-data;')
        ? 12 * 1024 * 1024 : DEFAULT_JSON_BODY_LIMIT)
      if (bodyContainsAccessToken(raw, contentType)) return send(res, 401, { error: 'AUTH_REQUIRED', message: '请求凭证位置无效' })
      if (!contentType.startsWith('multipart/form-data;')) {
        const body = await readJsonBody(req, DEFAULT_JSON_BODY_LIMIT)
        if (/^\/api\/subscriptions\/[^/]+\/review$/.test(url.pathname)) {
          try {
            reviewPermission = validateReviewAction(body)
            if (!Object.prototype.hasOwnProperty.call(body, 'result')) body.result = body.action
          } catch {
            return send(res, 400, { error: 'REVIEW_RESULT_INVALID', message: '复核结果不合法' })
          }
        }
      }
    }
    try {
      const context = await authenticateRequest(req, { iam })
      setAuthenticatedContext(req, context)
      if (reviewPermission) await requireApiPermission(context, reviewPermission, { iam })
    } catch (error) {
      const mapped = authErrorResponse(error)
      return send(res, mapped.status, { error: mapped.code, message: mapped.message })
    }
    if (req.method === 'GET' && url.pathname === '/api/auth/me') return send(res, 200, { data: permissionInfoForClient(iamContextFor(req)) })
    const context = iamContextFor(req)
    const role = requestContext(req).role
    if (role === 'employee' && !context.dataScope?.self && !context.dataScope?.all) {
      throw new AppError(403, 'DATA_SCOPE_DENIED', '无本人数据访问范围')
    }
    const adminScopedRead = role === 'admin' && req.method === 'GET'
      && (context.dataScope?.self || context.dataScope?.deptIds.includes(context.user?.deptId ?? ''))
      && (['/api/projects', '/api/rules', '/api/subscriptions', '/api/receiving-codes'].includes(url.pathname)
        || /^\/api\/procurement\/orders\/[^/]+$/.test(url.pathname)
        || /^\/api\/files\/[^/]+\/content$/.test(url.pathname))
    if (role !== 'employee' && !context.dataScope?.all && !adminScopedRead) {
      throw new AppError(403, 'DATA_SCOPE_MIGRATION_REQUIRED', '存量业务记录尚无部门归属，暂不能使用部门数据范围')
    }
    if (req.method === 'GET') return await routeGet(url, req, res)
    if (req.method === 'POST') return await routePost(url.pathname, req, res)
    return send(res, 405, { error: 'METHOD_NOT_ALLOWED' })
  } catch (error) {
    if (error instanceof AgreementError) return send(res, error.status, { error: error.code, message: error.message })
    if (error instanceof RequestBodyError) return send(res, error.status, { error: error.code, message: error.message })
    if (error instanceof AppError) return send(res, error.status, { error: error.code, message: error.message })
    const message = error instanceof Error ? error.message : ''
    if (/multipart|图片|文件名|文件内容|扩展名|表单字段|只能上传|必须上传/.test(message)) {
      return send(res, message.includes('超过大小') ? 413 : 400, { error: 'UPLOAD_INVALID', message })
    }
    logFailure('http.error', error)
    return send(res, 500, { error: 'INTERNAL_ERROR', message: '服务处理失败，请稍后重试' })
  }
}))

const port = Number(process.env.API_PORT ?? 4100)
server.requestTimeout = 15_000
server.headersTimeout = 10_000
server.listen(port, '127.0.0.1', () => {
  console.log(`subscription-api listening on http://127.0.0.1:${port}`)
  void runDueBackstops().catch(error => logFailure('company.backstop', error))
})
const backstopTimer = setInterval(() => {
  void runDueBackstops().catch(error => logFailure('company.backstop', error))
}, 30_000)
backstopTimer.unref()

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    clearInterval(backstopTimer)
    server.close(() => {
      void mongo.close().finally(() => process.exit(0))
    })
  })
}
