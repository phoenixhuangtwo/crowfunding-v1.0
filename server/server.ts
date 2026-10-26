import { observeRequests, logFailure, currentRequestId } from './observability.ts'
import { createServer, IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { fetchAllProcurementPages, fetchProcurementPage, formatProcurementSyncMessage } from './procurement.ts'
import { mapProcurementOrderToDetail, mapProcurementOrderToProject, mergeProcurementProject, procurementOrderSkipReason } from './procurement-project.ts'
import { recognizeFinanceBill } from './invoice-ocr.ts'
import { confirmProjectSettlement, type SettlementInvoiceRecord } from './project-settlement.ts'
import { DEFAULT_JSON_BODY_LIMIT, readJsonBody, RequestBodyError } from './http-json-body.ts'
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
import { requestContext, authorizeAssetRead } from './request-context.ts'
import { AppError, isDuplicateKey } from './errors.ts'
import { calculateShareSubscription, prepareShareRule } from './share-subscription.ts'
import { createFundLedger } from './finance/fund-ledger.ts'
import { validateContributionReview } from './finance/contribution-review.ts'
import { calculateSettlementProfit } from './finance/settlement-profit.ts'
import { planCompanyBackstop, paymentCutoffTime } from './company-backstop.ts'

type Role = 'employee' | 'admin' | 'finance' | 'super_admin' | 'system'
type ProjectStatus = '未开放' | '未满额' | '已满额' | '已截止' | '已中断' | '部分已结算' | '已完结'
type PaymentStatus = '未缴款' | '部分缴款' | '已缴款' | '待复核' | '复核驳回' | '已收款' | '已释放' | '公司待出资'

type PaymentImage = {
  id: string
  assetId: string
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
  settlementInvoices?: SettlementInvoiceRecord[]
}

type Subscription = {
  id: string
  projectId: string
  project: string
  userId: string
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
}

type AppState = {
  projects: Project[]
  subscriptions: Subscription[]
  auditLogs: AuditLog[]
  riskEvents: RiskEvent[]
  rules: SubscriptionRule[]
  receivingCodes: ReceivingCode[]
}

const mockProjects: Project[] = [
  {
    id: 'PRJ-MOCK-WKF-001',
    title: '未开放样例项目 A · 智能会议屏采购',
    source: 'Mock 数据',
    status: '未开放',
    statusType: 'info',
    progress: 0,
    remain: 80000,
    deadline: '2026-07-20 18:00',
    total: 80000,
    subscribed: 0,
    people: 0
  },
  {
    id: 'PRJ-MOCK-WKF-002',
    title: '未开放样例项目 B · 员工储物柜更新',
    source: 'Mock 数据',
    status: '未开放',
    statusType: 'info',
    progress: 0,
    remain: 56000,
    deadline: '2026-07-22 18:00',
    total: 56000,
    subscribed: 0,
    people: 0
  },
  {
    id: 'PRJ-MOCK-WME-001',
    title: '未满额样例项目 A · 茶水间设备补充',
    source: 'Mock 数据',
    status: '未满额',
    statusType: 'primary',
    progress: 42.5,
    remain: 34500,
    deadline: '2026-07-18 18:00',
    total: 60000,
    subscribed: 25500,
    people: 9
  },
  {
    id: 'PRJ-MOCK-WME-002',
    title: '未满额样例项目 B · 研发区显示器增购',
    source: 'Mock 数据',
    status: '未满额',
    statusType: 'primary',
    progress: 68,
    remain: 38400,
    deadline: '2026-07-19 18:00',
    total: 120000,
    subscribed: 81600,
    people: 18
  },
  {
    id: 'PRJ-MOCK-WME-003',
    title: '未满额测试数据 1 · 员工休息区咖啡机采购',
    source: 'Mock 数据',
    status: '未满额',
    statusType: 'primary',
    progress: 35,
    remain: 39000,
    deadline: '2026-07-05 12:00',
    total: 60000,
    subscribed: 21000,
    people: 7
  },
  {
    id: 'PRJ-MOCK-WME-004',
    title: '未满额测试数据 2 · 会议室白板屏增配',
    source: 'Mock 数据',
    status: '未满额',
    statusType: 'primary',
    progress: 48,
    remain: 41600,
    deadline: '2026-07-05 18:00',
    total: 80000,
    subscribed: 38400,
    people: 12
  },
  {
    id: 'PRJ-MOCK-WME-005',
    title: '未满额测试数据 3 · 工区人体工学椅补采',
    source: 'Mock 数据',
    status: '未满额',
    statusType: 'primary',
    progress: 57,
    remain: 34400,
    deadline: '2026-07-07 18:00',
    total: 80000,
    subscribed: 45600,
    people: 15
  },
  {
    id: 'PRJ-MOCK-WME-006',
    title: '未满额测试数据 4 · 茶水间冰箱更新',
    source: 'Mock 数据',
    status: '未满额',
    statusType: 'primary',
    progress: 64,
    remain: 28800,
    deadline: '2026-07-08 18:00',
    total: 80000,
    subscribed: 51200,
    people: 17
  },
  {
    id: 'PRJ-MOCK-WME-007',
    title: '未满额测试数据 5 · 培训摄像头套装采购',
    source: 'Mock 数据',
    status: '未满额',
    statusType: 'primary',
    progress: 71,
    remain: 34800,
    deadline: '2026-07-09 18:00',
    total: 120000,
    subscribed: 85200,
    people: 24
  },
  {
    id: 'PRJ-MOCK-YME-001',
    title: '已满额样例项目 A · 移动硬盘集中采购',
    source: 'Mock 数据',
    status: '已满额',
    statusType: 'success',
    progress: 100,
    remain: 0,
    deadline: '2026-07-10 18:00',
    total: 45000,
    subscribed: 45000,
    people: 20
  },
  {
    id: 'PRJ-MOCK-YME-002',
    title: '已满额样例项目 B · 工位照明升级',
    source: 'Mock 数据',
    status: '已满额',
    statusType: 'success',
    progress: 100,
    remain: 0,
    deadline: '2026-07-11 18:00',
    total: 72000,
    subscribed: 72000,
    people: 26
  },
  {
    id: 'PRJ-MOCK-YJZ-001',
    title: '已截止样例项目 A · 园区门禁维护',
    source: 'Mock 数据',
    status: '已截止',
    statusType: 'success',
    progress: 74,
    remain: 15600,
    deadline: '2026-07-03 18:00',
    total: 60000,
    subscribed: 44400,
    people: 16
  },
  {
    id: 'PRJ-MOCK-YJZ-002',
    title: '已截止样例项目 B · 备用网络设备',
    source: 'Mock 数据',
    status: '已截止',
    statusType: 'success',
    progress: 86,
    remain: 9800,
    deadline: '2026-07-04 18:00',
    total: 70000,
    subscribed: 60200,
    people: 21
  },
  {
    id: 'PRJ-MOCK-YZD-001',
    title: '已中断样例项目 A · 前台访客系统',
    source: 'Mock 数据',
    status: '已中断',
    statusType: 'danger',
    progress: 51,
    remain: 24500,
    deadline: '2026-07-16 18:00',
    total: 50000,
    subscribed: 25500,
    people: 11,
    interruptReason: 'Mock：供应计划调整，暂停本次认购。',
    interruptedAt: '2026-07-07 10:00:00',
    refundNotice: '已缴款金额将在 48h 内原路返款到账'
  },
  {
    id: 'PRJ-MOCK-YZD-002',
    title: '已中断样例项目 B · 健身区器材采购',
    source: 'Mock 数据',
    status: '已中断',
    statusType: 'danger',
    progress: 63,
    remain: 22200,
    deadline: '2026-07-17 18:00',
    total: 60000,
    subscribed: 37800,
    people: 14,
    interruptReason: 'Mock：采购口径变化，需重新评估认购规则。',
    interruptedAt: '2026-07-07 10:15:00',
    refundNotice: '已缴款金额将在 48h 内原路返款到账'
  },
  {
    id: 'PRJ-MOCK-YWJ-001',
    title: '已完结样例项目 A · 办公耳机采购',
    source: 'Mock 数据',
    status: '已完结',
    statusType: 'info',
    progress: 100,
    remain: 0,
    deadline: '2026-06-25 18:00',
    total: 52000,
    subscribed: 52000,
    people: 24
  },
  {
    id: 'PRJ-MOCK-YWJ-002',
    title: '已完结样例项目 B · 培训教室投影升级',
    source: 'Mock 数据',
    status: '已完结',
    statusType: 'info',
    progress: 100,
    remain: 0,
    deadline: '2026-06-26 18:00',
    total: 88000,
    subscribed: 88000,
    people: 32
  }
]

function buildMockReviewSubscriptions(): Subscription[] {
  return Array.from({ length: 20 }, (_, index) => {
    const amount = 4800 + index * 350
    const day = String(5 + Math.floor(index / 8)).padStart(2, '0')
    const hour = String(9 + (index % 8)).padStart(2, '0')
    const minute = String((index * 7) % 60).padStart(2, '0')
    const projectId = index % 2 === 0 ? 'PRJ-20260701-003' : 'PRJ-20260628-002'
    const project = projectId === 'PRJ-20260701-003' ? '2026-Q3 办公设备集采认购' : '员工餐厅冷链设备升级'
    const userId = index % 3 === 0 ? 'employee02' : 'employee01'
    return {
      id: `SUB-MOCK-REVIEW-${String(index + 1).padStart(3, '0')}`,
      projectId,
      project,
      userId,
      amount,
      pay: '待复核',
      profit: Math.round(amount * 0.082),
      action: '查看支付',
      idempotencyKey: `mock-review-${String(index + 1).padStart(3, '0')}`,
      createdAt: `2026-07-${day} ${hour}:${minute}:00`,
      paymentDeadlineAt: `2026-07-${day} ${String(Math.min(23, Number(hour) + 8)).padStart(2, '0')}:${minute}:00`,
      paymentUploadedAt: `2026-07-${day} ${hour}:${minute}:00`,
      paymentSuccessAt: `2026-07-${day} ${hour}:${String(Math.max(0, Number(minute) - 2)).padStart(2, '0')}:18`
    }
  })
}

const seedState: AppState = {
  projects: [
  {
    id: 'PRJ-20260701-003',
    title: '2026-Q3 办公设备集采认购',
    source: 'MCP 同步',
    status: '未满额',
    statusType: 'primary',
    progress: 73.4,
    remain: 79800,
    deadline: '2026-07-12 18:00',
    total: 300000,
    subscribed: 220200,
    people: 46
  },
  {
    id: 'PRJ-20260628-002',
    title: '员工餐厅冷链设备升级',
    source: '手工创建',
    status: '未满额',
    statusType: 'primary',
    progress: 91.2,
    remain: 10560,
    deadline: '2026-07-06 12:00',
    total: 120000,
    subscribed: 109440,
    people: 31
  },
  {
    id: 'PRJ-20260615-001',
    title: '园区安防摄像头替换',
    source: 'MCP 同步',
    status: '已满额',
    statusType: 'success',
    progress: 100,
    remain: 0,
    deadline: '2026-06-30 18:00',
    total: 180000,
    subscribed: 180000,
    people: 52
  },
  ...mockProjects
  ],
  subscriptions: [
    { id: 'SUB-20260705-0031', projectId: 'PRJ-20260701-003', project: '2026-Q3 办公设备集采认购', userId: 'employee01', amount: 12000, pay: '待复核', profit: 984, action: '查看支付', idempotencyKey: 'seed-001' },
    { id: 'SUB-20260704-0027', projectId: 'PRJ-20260628-002', project: '员工餐厅冷链设备升级', userId: 'employee01', amount: 6000, pay: '未缴款', profit: 492, action: '去支付', idempotencyKey: 'seed-002' },
    { id: 'SUB-20260412-0006', projectId: 'PRJ-20260410-006', project: '2026-Q2 IT 外设集采', userId: 'employee01', amount: 18000, pay: '待确认收款', profit: 3640, action: '确认收款', idempotencyKey: 'seed-003' },
    { id: 'SUB-MOCK-WJK-001', projectId: 'PRJ-MOCK-WME-001', project: '样例认购 · 未缴款 01', userId: 'employee01', amount: 3200, pay: '未缴款', profit: 260, action: '去支付', idempotencyKey: 'mock-pay-unpaid-001', createdAt: '2026-08-27 09:00:00', paymentDeadlineAt: '2026-08-28 09:00:00' },
    { id: 'SUB-MOCK-WJK-002', projectId: 'PRJ-MOCK-WME-002', project: '样例认购 · 未缴款 02', userId: 'employee01', amount: 8800, pay: '未缴款', profit: 720, action: '去支付', idempotencyKey: 'mock-pay-unpaid-002', createdAt: '2026-08-27 09:15:00', paymentDeadlineAt: '2026-08-28 09:15:00' },
    { id: 'SUB-MOCK-WJK-003', projectId: 'PRJ-MOCK-WKF-002', project: '样例认购 · 未缴款 03', userId: 'employee01', amount: 5200, pay: '未缴款', profit: 426, action: '去支付', idempotencyKey: 'mock-pay-unpaid-003', createdAt: '2026-08-27 09:30:00', paymentDeadlineAt: '2026-08-28 09:30:00' },
    { id: 'SUB-MOCK-WJK-004', projectId: 'PRJ-MOCK-YWJ-002', project: '样例认购 · 未缴款 04', userId: 'employee01', amount: 7600, pay: '未缴款', profit: 623, action: '去支付', idempotencyKey: 'mock-pay-unpaid-004', createdAt: '2026-08-27 09:45:00', paymentDeadlineAt: '2026-08-28 09:45:00' },
    { id: 'SUB-MOCK-WJK-005', projectId: 'PRJ-MOCK-WME-007', project: '样例认购 · 未缴款 05', userId: 'employee01', amount: 4100, pay: '未缴款', profit: 336, action: '去支付', idempotencyKey: 'mock-pay-unpaid-005', createdAt: '2026-08-27 10:00:00', paymentDeadlineAt: '2026-08-28 10:00:00' },
    { id: 'SUB-MOCK-WJK-006', projectId: 'PRJ-MOCK-WME-001', project: '样例认购 · 未缴款 06', userId: 'employee01', amount: 4600, pay: '未缴款', profit: 377, action: '去支付', idempotencyKey: 'mock-pay-unpaid-006', createdAt: '2026-08-27 10:15:00', paymentDeadlineAt: '2026-08-28 10:15:00' },
    { id: 'SUB-MOCK-WJK-007', projectId: 'PRJ-MOCK-WME-002', project: '样例认购 · 未缴款 07', userId: 'employee01', amount: 5900, pay: '未缴款', profit: 484, action: '去支付', idempotencyKey: 'mock-pay-unpaid-007', createdAt: '2026-08-27 10:30:00', paymentDeadlineAt: '2026-08-28 10:30:00' },
    { id: 'SUB-MOCK-WJK-008', projectId: 'PRJ-MOCK-WKF-002', project: '样例认购 · 未缴款 08', userId: 'employee01', amount: 6800, pay: '未缴款', profit: 558, action: '去支付', idempotencyKey: 'mock-pay-unpaid-008', createdAt: '2026-08-27 10:45:00', paymentDeadlineAt: '2026-08-28 10:45:00' },
    { id: 'SUB-MOCK-WJK-009', projectId: 'PRJ-MOCK-YWJ-002', project: '样例认购 · 未缴款 09', userId: 'employee01', amount: 7900, pay: '未缴款', profit: 648, action: '去支付', idempotencyKey: 'mock-pay-unpaid-009', createdAt: '2026-08-27 11:00:00', paymentDeadlineAt: '2026-08-28 11:00:00' },
    { id: 'SUB-MOCK-WJK-010', projectId: 'PRJ-MOCK-WME-007', project: '样例认购 · 未缴款 10', userId: 'employee01', amount: 9500, pay: '未缴款', profit: 779, action: '去支付', idempotencyKey: 'mock-pay-unpaid-010', createdAt: '2026-08-27 11:15:00', paymentDeadlineAt: '2026-08-28 11:15:00' },
    { id: 'SUB-MOCK-DFH-001', projectId: 'PRJ-MOCK-WME-001', project: '样例认购 · 待复核 A', userId: 'employee01', amount: 5600, pay: '待复核', profit: 458, action: '查看支付', idempotencyKey: 'mock-pay-review-001' },
    { id: 'SUB-MOCK-DFH-002', projectId: 'PRJ-MOCK-WME-002', project: '样例认购 · 待复核 B', userId: 'employee01', amount: 9300, pay: '待复核', profit: 762, action: '查看支付', idempotencyKey: 'mock-pay-review-002' },
    { id: 'SUB-MOCK-BH-001', projectId: 'PRJ-MOCK-WZD-001', project: '样例认购 · 复核驳回 A', userId: 'employee01', amount: 4200, pay: '复核驳回', profit: 344, action: '重新上传截图', idempotencyKey: 'mock-pay-rejected-001', rejectReason: '支付截图缺少交易单号，无法与认购记录完成匹配，请重新上传包含支付成功页、金额、交易流水和收款方信息的截图。' },
    { id: 'SUB-MOCK-BH-002', projectId: 'PRJ-MOCK-WZD-002', project: '样例认购 · 复核驳回 B', userId: 'employee01', amount: 7600, pay: '复核驳回', profit: 623, action: '重新上传截图', idempotencyKey: 'mock-pay-rejected-002', rejectReason: 'OCR 识别金额与申请认购金额不一致，截图疑似为其他付款记录，请重新支付或上传正确的支付成功截图。' },
    { id: 'SUB-MOCK-SK-001', projectId: 'PRJ-MOCK-YZD-001', project: '样例认购 · 待确认收款 A', userId: 'employee01', amount: 10400, pay: '待确认收款', profit: 853, action: '确认收款', idempotencyKey: 'mock-pay-receipt-001' },
    { id: 'SUB-MOCK-SK-002', projectId: 'PRJ-MOCK-YZD-002', project: '样例认购 · 待确认收款 B', userId: 'employee01', amount: 15800, pay: '待确认收款', profit: 1295, action: '确认收款', idempotencyKey: 'mock-pay-receipt-002' },
    ...buildMockReviewSubscriptions()
  ],
  auditLogs: [
    { time: '2026-07-05 10:32:01', actor: '张明 · 员工', role: 'employee', action: '上传支付截图', target: 'PAY-20260705-0092', before: null, after: { ocr_status: '待复核' }, result: '成功' },
    { time: '2026-07-04 16:08:45', actor: '周敏 · 财务', role: 'finance', action: '支付复核 · 驳回', target: 'PAY-20260703-0087', before: { status: '待复核' }, after: { status: '复核驳回' }, result: '成功' },
    { time: '2026-07-02 10:00:12', actor: '周敏 · 财务', role: 'finance', action: '替换收款码', target: 'PRJ-20260701-003', before: { qr: 'QR-20260701-00.png' }, after: { qr: 'QR-20260702-01.png' }, result: '成功' },
    { time: '2026-06-30 18:00:03', actor: '系统', role: 'system', action: '自动兜底接管', target: 'TKV-20260430-01', before: { gap: 54160 }, after: { company_takeover_amount: 54160 }, result: '成功' }
  ],
  riskEvents: [
    { time: '2026-07-05 10:35', level: '高', desc: 'OCR 金额与应付金额不一致（¥1,200 ≠ ¥5,500）', status: '待处理' },
    { time: '2026-07-05 09:00', level: '中', desc: '项目「冷链设备升级」24 小时内截止，预估缺口 ¥10,560', status: '已通知公司超管' }
  ],
  rules: [
    {
      id: 'RULE-20260701-001',
      projectId: 'PRJ-20260701-003',
      projectName: '2026-Q3 办公设备集采认购',
      ruleName: '办公设备集采默认认购规则',
      totalAmount: 300000,
      companyFixedAmount: 60000,
      minAmount: 100,
      minParticipants: 20,
      receivingCodeId: 'RCV-20260701-001',
      allowMultiple: true,
      companyTakeover: true,
      status: '已启用',
      startAt: '2026-07-02 10:00',
      endAt: '2026-07-12 18:00',
      updatedAt: '2026-07-05 10:00'
    },
    {
      id: 'RULE-20260628-001',
      projectId: 'PRJ-20260628-002',
      projectName: '员工餐厅冷链设备升级',
      ruleName: '冷链设备升级限时认购规则',
      totalAmount: 120000,
      companyFixedAmount: 24000,
      minAmount: 100,
      minParticipants: 12,
      receivingCodeId: 'RCV-20260701-001',
      allowMultiple: true,
      companyTakeover: true,
      status: '已启用',
      startAt: '2026-06-29 09:00',
      endAt: '2026-07-06 12:00',
      updatedAt: '2026-07-04 16:30'
    }
  ],
  receivingCodes: [
    {
      id: 'RCV-20260701-001',
      subject: 'XX 科技有限公司',
      accountNote: '支付宝收款码 · 财务专用',
      codeName: '支付宝收款码',
      status: '启用',
      updatedBy: 'finance01 · 财务',
      updatedAt: '2026-07-07 20:30:00'
    },
    {
      id: 'RCV-20260628-002',
      subject: 'XX 科技有限公司',
      accountNote: '银行转账收款码 · 项目专用',
      codeName: '银行转账码',
      status: '已禁用',
      updatedBy: 'finance01 · 财务',
      updatedAt: '2026-07-06 18:40:00',
      disabledReason: '收款账户维护，暂停使用'
    }
  ]
}

function normalizeProjectFinance(project: Project) {
  const costAmount = Number(project.costAmount)
  const normalizedCost = Number.isFinite(costAmount) && costAmount >= project.total
    ? costAmount
    : Math.ceil(project.total * 1.2)
  const salesAmount = Number(project.salesAmount)
  const normalizedSales = Number.isFinite(salesAmount) && salesAmount >= normalizedCost
    ? salesAmount
    : Math.ceil(normalizedCost * 1.18)
  project.costAmount = normalizedCost
  project.salesAmount = normalizedSales
  project.profitAmount = normalizedSales - normalizedCost
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

function normalizeProjectStatus(project: (Omit<Project, 'status' | 'costAmount' | 'salesAmount' | 'profitAmount'> & Partial<Pick<Project, 'costAmount' | 'salesAmount' | 'profitAmount'>> & { status: string })): Project {
  const normalized = { ...project } as Project
  normalizeProjectFinance(normalized)
  normalizeProjectAmounts(normalized)
  normalized.settlementInvoices = Array.isArray(project.settlementInvoices) ? project.settlementInvoices : []
  normalized.settledAmount = Number((Number(project.settledAmount) || normalized.settlementInvoices.reduce((sum, invoice) => sum + Number(invoice.amount || 0), 0)).toFixed(2))
  if (project.status === '已中断') {
    normalized.status = '已中断'
    normalized.statusType = 'danger'
    return normalized
  }
  if (['草稿', '未开放'].includes(project.status)) {
    normalized.status = '未开放'
    normalized.statusType = 'info'
    return normalized
  }
  if (['认购中', '即将截止', '开放中', '未满额'].includes(project.status)) {
    normalized.status = normalized.remain <= 0 || normalized.progress >= 100 ? '已满额' : '未满额'
    normalized.statusType = normalized.status === '已满额' ? 'success' : 'primary'
    return normalized
  }
  if (project.status === '已满额') {
    normalized.status = '已满额'
    normalized.statusType = 'success'
    return normalized
  }
  if (project.status === '部分已结算') {
    normalized.status = '部分已结算'
    normalized.statusType = 'warning'
    return normalized
  }
  if (['已结束未结算', '已结算', '已冻结', '已完结'].includes(project.status)) {
    normalized.status = '已完结'
    normalized.statusType = 'info'
    return normalized
  }
  normalized.status = '已截止'
  normalized.statusType = 'success'
  return normalized
}

function normalizeSubscription(subscription: Omit<Subscription, 'createdAt' | 'paymentDeadlineAt'> & Partial<Pick<Subscription, 'createdAt' | 'paymentDeadlineAt' | 'paymentUploadedAt' | 'paymentSuccessAt' | 'paymentImageUrl' | 'paymentImageName' | 'reviewedBy' | 'reviewedAt' | 'rejectReason'>>): Subscription {
  const createdAt = formatDateTime(parseDateTime(subscription.createdAt))
  const paymentDeadlineAt = subscription.paymentDeadlineAt && subscription.paymentDeadlineAt !== 'Invalid Date'
    ? formatDateTime(parseDateTime(subscription.paymentDeadlineAt))
    : addHours(createdAt, 12)
  const pay = subscription.projectId === 'PRJ-FSY-OFFLINE-368' && subscription.pay === '已缴款' && !subscription.reviewedAt
    ? '待复核'
    : subscription.pay
  const action = pay === '未缴款' ? '去支付' : subscription.action
  const rejectReason = pay === '复核驳回'
    ? subscription.rejectReason || '支付截图信息不完整，请重新上传包含金额、收款方与交易流水的支付成功截图。'
    : undefined
  const legacyRecognizedAmount = subscription.pay === '已缴款' || subscription.pay === '已收款'
    ? Number(subscription.amount) || 0
    : 0
  const paymentImages = subscription.paymentImages?.length
    ? subscription.paymentImages
    : subscription.paymentImageUrl && subscription.paymentImageName
      ? [{
          id: `PAYIMG-LEGACY-${subscription.id}`,
          paymentImageUrl: subscription.paymentImageUrl,
          paymentImageName: subscription.paymentImageName,
          recognizedAmount: Number(subscription.recognizedPaidAmount ?? legacyRecognizedAmount),
          uploadedAt: subscription.paymentUploadedAt || createdAt,
          status: '已识别' as const
        }]
      : []
  const recognizedPaidAmount = Number(paymentImages
    .filter(image => image.status === '已识别')
    .reduce((sum, image) => sum + Number(image.recognizedAmount || 0), 0).toFixed(2))
  return {
    ...subscription,
    pay,
    action,
    rejectReason,
    createdAt,
    paymentDeadlineAt,
    paymentImages,
    recognizedPaidAmount
  }
}

function normalizeRuleStatus(status: unknown): SubscriptionRule['status'] {
  if (status === '已发布') return '已启用'
  if (status === '草稿') return '未启用'
  if (status === '已启用' || status === '未启用' || status === '已停用') return status
  return '未启用'
}

function normalizeRule(rule: SubscriptionRule): SubscriptionRule {
  const companyFixedAmount = Number(rule.companyFixedAmount)
  return {
    ...rule,
    companyFixedAmount: Number.isFinite(companyFixedAmount) ? Math.max(0, companyFixedAmount) : 0,
    receivingCodeId: rule.receivingCodeId || 'RCV-20260701-001',
    status: normalizeRuleStatus(rule.status)
  }
}

function normalizeState(input: Partial<AppState>): AppState {
  const normalizedProjects = (input.projects ?? structuredClone(seedState.projects)).map(normalizeProjectStatus)
  const findProject = (subscription: Subscription) => normalizedProjects.find(project => project.id === subscription.projectId || project.title === subscription.project)
  const reviewMocks = buildMockReviewSubscriptions()
  const sourceSubscriptions = input.subscriptions ?? structuredClone(seedState.subscriptions)
  const subscriptionIds = new Set(sourceSubscriptions.map(item => item.id))
  const mergedSubscriptions = [
    ...sourceSubscriptions,
    ...reviewMocks.filter(item => !subscriptionIds.has(item.id))
  ]
  return {
    projects: normalizedProjects,
    subscriptions: mergedSubscriptions.map(normalizeSubscription).map(subscription => {
      const project = findProject(subscription)
      return project ? { ...subscription, profit: project.profitAmount } : subscription
    }),
    auditLogs: input.auditLogs ?? structuredClone(seedState.auditLogs),
    riskEvents: input.riskEvents ?? structuredClone(seedState.riskEvents),
    rules: (input.rules ?? structuredClone(seedState.rules)).map(normalizeRule),
    receivingCodes: input.receivingCodes ?? structuredClone(seedState.receivingCodes)
  }
}

function isCompanySubscription(subscription: Subscription) {
  return ['company', 'company01', 'superadmin01'].includes(subscription.userId)
}

function hasRealUserSubscriptions(projectId: string) {
  return subscriptions.some(item => item.projectId === projectId && !isCompanySubscription(item))
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
const mongo = await connectMongo(appConfig.mongodb)
await ensureSchema(mongo.db, appConfig.mongodb.collectionPrefix)
const repositories = createRepositories(mongo.db, appConfig.mongodb.collectionPrefix)
const fundLedger = createFundLedger(mongo.db, appConfig.mongodb.collectionPrefix)
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
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json; charset=utf-8'
  })
  res.end(JSON.stringify(payload))
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
          const cutoffInput = { subscriptionCutoffAt: project.deadline, employeePaymentDeadlines: employees.map(record => record.paymentDeadlineAt) }
          const currentTime = new Date()
          if (currentTime.getTime() < paymentCutoffTime(cutoffInput)) return null
          const released = employees.filter(record => record.pay === '未缴款')
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
  if (context.role !== 'admin' && context.role !== 'finance') throw new AppError(403, 'FORBIDDEN', '只有管理员或财务可以维护收款码')
  return { ...context, label: `${context.userId} · ${context.role === 'admin' ? '管理员' : '财务'}` }
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
  const fileMatch = pathname.match(/^\/api\/files\/([^/]+)\/content$/)
  if (fileMatch) {
    const context = requestContext(req)
    const asset = await fileAssetService.getReadyAsset(decodeURIComponent(fileMatch[1]))
    if (!asset) return send(res, 404, { error: 'FILE_NOT_FOUND', message: '文件不存在或无权访问' })
    await authorizeAssetRead(context, asset, repositories)
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
    if (context.role === 'employee') throw new AppError(403, 'FORBIDDEN', '员工不能访问全量业务状态')
    return send(res, 200, { data: await queryService.state(), persistence: 'mongodb' })
  }
  if (pathname === '/api/projects') return send(res, 200, { data: await queryService.listProjects() })
  if (pathname === '/api/receiving-codes') {
    const context = requestContext(req)
    const codes = await queryService.listReceivingCodes()
    if (context.role !== 'employee') return send(res, 200, { data: codes })
    const projectIds = new Set((await queryService.listSubscriptions(context))
      .filter(item => item.pay !== '已释放').map(item => item.projectId))
    const codeIds = new Set(rules.filter(rule => projectIds.has(rule.projectId)).map(rule => rule.receivingCodeId))
    return send(res, 200, { data: codes.filter(code => codeIds.has(code.id)) })
  }
  const procurementDetailMatch = pathname.match(/^\/api\/procurement\/orders\/([^/]+)$/)
  if (procurementDetailMatch) {
    const projectId = decodeURIComponent(procurementDetailMatch[1])
    const project = projects.find(item => item.id === projectId)
    if (!project) return send(res, 404, { error: 'PROJECT_NOT_FOUND', message: '项目不存在' })

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
      const keywordMatched = !keyword || [rule.ruleName, rule.projectName, rule.id].some(value => value.includes(keyword))
      const statusMatched = !status || status === '全部' || rule.status === status
      const projectMatched = !projectId || projectId === '全部' || rule.projectId === projectId
      return keywordMatched && statusMatched && projectMatched
    })
    return send(res, 200, { data: filtered })
  }
  if (pathname === '/api/subscriptions') return send(res, 200, { data: await queryService.listSubscriptions(requestContext(req)) })
  if (pathname === '/api/audit-logs') {
    const context = requestContext(req)
    if (context.role === 'employee') throw new AppError(403, 'FORBIDDEN', '员工不能查看全量审计日志')
    return send(res, 200, { data: await repositories.auditLogs.list({}, { sort: { time: -1 } }) })
  }
  if (pathname === '/api/risk-events') {
    const context = requestContext(req)
    if (context.role === 'employee') throw new AppError(403, 'FORBIDDEN', '员工不能查看全量风险事件')
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
      shareRule = prepareShareRule(project.costAmount, Number(body.sharePrice), Number(body.companyFrontShares), Number(body.maxSharesPerEmployee))
    } catch (error) {
      send(res, 400, { error: 'SHARE_RULE_INVALID', message: error instanceof Error ? error.message : '份额规则无效' })
      return null
    }
  }
  const companyFixedAmount = shareRule?.companyFixedAmount ?? Number(body.companyFixedAmount ?? 0)
  const minParticipants = shareRule ? 1 : Number(body.minParticipants)
  const receivingCodeId = String(body.receivingCodeId ?? '').trim()
  if (!body.ruleName) {
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
  const settlementOperator = pathname === '/api/invoices/ocr' || pathname === '/api/invoices/pending/delete'
    || /^\/api\/projects\/[^/]+\/settlements\/confirm$/.test(pathname)
    ? financeOperator(req) : undefined
  if (pathname === '/api/settlements/calc') {
    const context = requestContext(req)
    if (context.role === 'employee') throw new AppError(403, 'FORBIDDEN', '员工不能访问结算试算')
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
    const context = requestContext(req)
    const { fields, image } = await readValidatedUpload(
      req,
      ['paymentId', 'subscriptionId', 'expectedAmount', 'operator'],
      ['image/png', 'image/jpeg', 'image/bmp']
    )
    const subscriptionId = fields.subscriptionId?.trim()
    const current = subscriptionId ? await repositories.subscriptions.getById(subscriptionId) : null
    if (!current) return send(res, 404, { error: 'SUBSCRIPTION_NOT_FOUND', message: '认购记录不存在' })
    if (context.role !== 'employee' || current.userId !== context.userId) throw new AppError(403, 'FORBIDDEN', '只能上传本人认购的支付截图')
    if (['已缴款', '已收款', '已释放', '公司待出资'].includes(current.pay)) return send(res, 409, { error: 'PAYMENT_NOT_UPLOADABLE', message: '该认购状态不允许上传支付截图' })
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
        const pay = latest.shares !== undefined
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
    const { fields, image } = await readValidatedUpload(req, ['projectId', 'fileName', 'operator'], ['image/png', 'image/jpeg', 'image/bmp'])
    const projectId = fields.projectId?.trim()
    const project = projectId ? await repositories.projects.getById(projectId) : null
    if (!project) return send(res, 404, { error: 'PROJECT_NOT_FOUND', message: '项目不存在' })
    if (!['已满额', '已截止', '部分已结算'].includes(project.status)) {
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

  if (pathname === '/api/invoices/ocr') {
    const imageDataUrl = typeof body.imageDataUrl === 'string' ? body.imageDataUrl.trim() : ''
    const fileName = typeof body.fileName === 'string' ? body.fileName.trim() : ''
    const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : ''
    const project = projects.find(item => item.id === projectId)
    if (!project) return send(res, 404, { error: 'PROJECT_NOT_FOUND', message: '项目不存在' })
    if (!['已满额', '已截止', '部分已结算'].includes(project.status)) {
      return send(res, 409, { error: 'PROJECT_NOT_SETTLEMENT_ELIGIBLE', message: '项目当前状态不允许发起结算识别' })
    }
    if (!fileName || fileName.length > 255) {
      return send(res, 400, { error: 'INVOICE_IMAGE_NAME_INVALID', message: '发票图片文件名无效' })
    }
    if (!ensureImageStorageCapacity(res, imageDataUrl)) return
    try {
      ocrQuota.take('ocr')
      const data = await recognizeFinanceBill({
        imageDataUrl,
        appCode: process.env.INVOICE_OCR_APPCODE ?? '',
        endpoint: process.env.INVOICE_OCR_API_URL,
      })
      if (!Number.isFinite(data.amount) || Number(data.amount) < 0.01) {
        return send(res, 200, { data, message: 'OCR 已完成，但未识别到可结算金额' })
      }
      const proof = ocrProofStore.create({ projectId, imageDataUrl, fileName, result: data })
      return send(res, 200, { data: { ...data, settlementProofId: proof.proofId, proofExpiresAt: proof.expiresAt }, message: '发票 OCR 识别完成' })
    } catch (error) {
      const message = error instanceof Error ? error.message : '发票识别失败'
      const status = error instanceof ResourceLimitError ? 429 : message.startsWith('未配置') ? 503 : message.includes('仅支持') || message.includes('5MB') ? 400 : message.includes('凭证已达上限') ? 422 : 502
      return send(res, status, { error: 'INVOICE_OCR_FAILED', message })
    }
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
    if (!body.agreementsConfirmed) return send(res, 409, { error: 'AGREEMENT_REQUIRED', message: '请先确认当前有效协议' })
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
    project.employeeSubscribedAmount += amount
    project.people += 1
    normalizeProjectAmounts(project)
    if (project.remain <= 0 || project.progress >= 100) {
      project.status = '已满额'
      project.statusType = 'success'
    }

    const createdAt = now()
    const record: Subscription = {
      id: `SUB-${Date.now()}`,
      projectId: project.id,
      project: project.title,
      userId,
      amount,
      shares,
      pay: '未缴款',
      profit: project.profitAmount,
      action: '去支付',
      idempotencyKey: String(body.idempotencyKey),
      createdAt,
      paymentDeadlineAt: addHours(createdAt, 12)
    }
    subscriptions.unshift(record)
    await pushAudit({ actor: `${record.userId} · 员工`, role: 'employee', action: '创建认购', target: record.id, before, after: { subscribed: project.subscribed, remain: project.remain, subscription: record.id } })
    await persistState()
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
    const before = { pay: subscription.pay, action: subscription.action }
    subscription.pay = '已收款'
    subscription.action = '查看支付'
    await pushAudit({
      actor: `${context.userId} · 员工`,
      role: 'employee',
      action: '确认收款',
      target: subscription.id,
      before,
      after: { pay: subscription.pay, action: subscription.action },
      result: '成功'
    })
    await persistState()
    return send(res, 200, { data: subscription, message: '已确认收款，状态已更新为已收款' })
  }

  const reviewMatch = pathname.match(/^\/api\/subscriptions\/([^/]+)\/review$/)
  if (reviewMatch) {
    const context = requestContext(req)
    if (context.role !== 'finance') throw new AppError(403, 'FORBIDDEN', '只有财务可以复核支付')
    const subscriptionId = decodeURIComponent(reviewMatch[1])
    const subscription = subscriptions.find(item => item.id === subscriptionId)
    if (!subscription) return send(res, 404, { error: 'SUBSCRIPTION_NOT_FOUND', message: '认购记录不存在' })
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
      ruleName: body.ruleName,
      totalAmount,
      ...shareRule,
      companyFixedAmount,
      minAmount,
      minParticipants,
      receivingCodeId,
      allowMultiple: Boolean(body.allowMultiple),
      companyTakeover: shareRule ? true : Boolean(body.companyTakeover),
      status: normalizeRuleStatus(body.status),
      startAt: body.startAt ?? '',
      endAt: body.endAt ?? '',
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
    if (isRuleLocked(rule.id)) {
      return send(res, 409, {
        error: 'RULE_LOCKED_BY_SUBSCRIPTION',
        message: '该规则已被有真实认购记录的项目使用，不支持修改规则配置内容。'
      })
    }
    const validated = validateRulePayload(body, res)
    if (!validated) return
    const { project, totalAmount, companyFixedAmount, minAmount, minParticipants, receivingCodeId, shareRule } = validated
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
    rule.updatedAt = now()
    await pushAudit({ actor: manager!.label, role: manager!.role, action: '修改认购规则', target: rule.id, before, after: rule })
    await persistState()
    return send(res, 200, { data: rule, message: '认购规则已修改' })
  }

  if (pathname.startsWith('/api/rules/') && pathname.endsWith('/status')) {
    const ruleId = pathname.split('/')[3]
    const rule = rules.find(item => item.id === ruleId)
    if (!rule) return send(res, 404, { error: 'RULE_NOT_FOUND', message: '认购规则不存在' })
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
    if (selectedRule.projectId !== project.id) {
      return send(res, 409, { error: 'RULE_PROJECT_MISMATCH', message: '开放认购前必须选择当前项目归属的认购规则' })
    }
    if (selectedRule.status !== '已启用') {
      return send(res, 409, { error: 'RULE_NOT_ENABLED', message: '开放认购前必须先启用当前项目归属的认购规则' })
    }
    if (selectedRule.totalAmount < 0 || selectedRule.totalAmount > project.costAmount) {
      return send(res, 409, { error: 'OPEN_AMOUNT_EXCEEDS_COST', message: '开放认购金额必须满足 0≦开放认购金额≦项目成本金额' })
    }
    const before = { status: project.status, total: project.total, deadline: project.deadline, ruleId: project.ruleId }
    project.ruleId = selectedRule.id
    project.total = selectedRule.totalAmount
    project.companyFixedAmount = selectedRule.companyFixedAmount
    project.deadline = selectedRule.endAt || project.deadline
    normalizeProjectAmounts(project)
    project.status = '未满额'
    project.statusType = 'primary'
    project.interruptReason = undefined
    project.interruptedAt = undefined
    project.refundNotice = undefined
    await pushAudit({
      actor: manager!.label,
      role: manager!.role,
      action: '开放项目认购',
      target: project.id,
      before,
      after: {
        status: project.status,
        total: project.total,
        deadline: project.deadline,
        ruleId: selectedRule.id,
        ruleName: selectedRule.ruleName
      }
    })
    await persistState()
    return send(res, 200, { data: project, message: `项目已按「${selectedRule.ruleName}」开放，状态为未满额` })
  }

  if (pathname.startsWith('/api/projects/') && pathname.endsWith('/terminate')) {
    const projectId = pathname.split('/')[3]
    const project = projects.find(item => item.id === projectId)
    if (!project) return send(res, 404, { error: 'PROJECT_NOT_FOUND', message: '项目不存在' })
    if (project.status !== '未开放' && project.status !== '未满额') {
      return send(res, 409, { error: 'PROJECT_STATUS_INVALID', message: '只有未开放或未满额项目可以终止' })
    }
    const before = { status: project.status, remain: project.remain }
    project.status = '已中断'
    project.statusType = 'danger'
    project.interruptReason = '管理端终止认购'
    project.interruptedAt = now()
    project.refundNotice = '已缴款金额将在 48h 内原路返款到账'
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
    return send(res, 200, { data: project, message: '项目已终止并进入已中断状态' })
  }

  if (pathname.startsWith('/api/projects/') && pathname.endsWith('/interrupt')) {
    const projectId = pathname.split('/')[3]
    const project = projects.find(item => item.id === projectId)
    const reason = String(body.reason ?? '').trim()
    if (!project) return send(res, 404, { error: 'PROJECT_NOT_FOUND', message: '项目不存在' })
    if (!reason) return send(res, 400, { error: 'INTERRUPT_REASON_REQUIRED', message: '中断认购必须填写中断原因' })
    if (project.status !== '未满额') {
      return send(res, 409, { error: 'PROJECT_NOT_OPEN', message: '只有未满额项目可以中断认购' })
    }
    const before = { status: project.status, remain: project.remain, interruptReason: project.interruptReason }
    project.status = '已中断'
    project.statusType = 'danger'
    project.interruptReason = reason
    project.interruptedAt = now()
    project.refundNotice = '已缴款金额将在 48h 内原路返款到账'
    riskEvents.unshift({
      time: now(),
      level: '高',
      desc: `项目「${project.title}」已中断认购：${reason}；已缴款金额将在 48h 内返款到账`,
      status: '已通知员工与财务'
    })
    await pushAudit({
      actor: manager!.label,
      role: manager!.role,
      action: '中断项目认购',
      target: project.id,
      before,
      after: { status: project.status, interruptReason: reason, refundNotice: project.refundNotice }
    })
    await persistState()
    return send(res, 200, { data: project, message: project.refundNotice })
  }

  if (pathname === '/api/payments/images/delete') {
    const subscription = await repositories.subscriptions.getById(String(body.subscriptionId ?? ''))
    if (!subscription) {
      return send(res, 404, { error: 'SUBSCRIPTION_NOT_FOUND', message: '认购记录不存在' })
    }
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
      const remainingImages = (latest.paymentImages ?? []).filter(item => item.id !== imageId)
      const latestImage = remainingImages.at(-1)
      const recognizedTotal = Number(remainingImages.filter(item => item.status === '已识别').reduce((sum, item) => sum + item.recognizedAmount, 0).toFixed(2))
      const hasFailedImage = remainingImages.some(item => item.status === '识别失败')
      const pay = latest.shares !== undefined
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

  if (pathname === '/api/payments/ocr') {
    const subscription = subscriptions.find(item => item.id === body.subscriptionId)
    const paymentImageUrl = typeof body.paymentImageUrl === 'string' ? body.paymentImageUrl.trim() : undefined
    const paymentImageName = typeof body.paymentImageName === 'string' ? body.paymentImageName.trim() : undefined
    if (!subscription) {
      return send(res, 404, { error: 'SUBSCRIPTION_NOT_FOUND', message: '认购记录不存在' })
    }
    const context = requestContext(req)
    if (context.role !== 'employee' || subscription.userId !== context.userId) throw new AppError(403, 'FORBIDDEN', '只能上传本人认购的支付截图')
    if (['已缴款', '已收款', '已释放', '公司待出资'].includes(subscription.pay)) {
      return send(res, 409, { error: 'PAYMENT_NOT_UPLOADABLE', message: '该认购状态不允许上传支付截图' })
    }
    if (subscription.shares !== undefined && Date.now() > new Date(subscription.paymentDeadlineAt.replace(' ', 'T')).getTime()) {
      return send(res, 409, { error: 'PAYMENT_DEADLINE_PASSED', message: '该认购的缴款期限已结束' })
    }
    if (!paymentImageUrl || !supportedPaymentImageDataUrl.test(paymentImageUrl) || paymentImageUrl.length > maxImageDataUrlLength) {
      return send(res, 400, { error: 'PAYMENT_IMAGE_INVALID', message: '支付截图仅支持 PNG、JPG 或 BMP 格式，且大小不能超过 5MB' })
    }
    if (!paymentImageName || paymentImageName.length > 255) {
      return send(res, 400, { error: 'PAYMENT_IMAGE_NAME_INVALID', message: '支付截图文件名无效' })
    }
    if ((subscription.paymentImages?.length ?? 0) >= maxPaymentImagesPerSubscription) {
      return send(res, 429, { error: 'PAYMENT_IMAGE_LIMIT_EXCEEDED', message: `每笔认购最多保留 ${maxPaymentImagesPerSubscription} 张支付截图` })
    }
    if (!ensureImageStorageCapacity(res, paymentImageUrl, subscription.paymentImageUrl ?? '', 2)) return
    const expectedAmount = Number(subscription.amount)
    let recognizedAmount = 0
    let recognitionFailure = ''
    try {
      ocrQuota.take('ocr')
      const recognition = await recognizeFinanceBill({
        imageDataUrl: paymentImageUrl,
        appCode: process.env.INVOICE_OCR_APPCODE ?? '',
        endpoint: process.env.INVOICE_OCR_API_URL,
      })
      if (recognition.amount !== undefined && Number.isFinite(recognition.amount) && recognition.amount > 0 && recognition.amount <= 1_000_000_000) {
        recognizedAmount = recognition.amount
      } else {
        recognitionFailure = '未识别到有效交易金额'
      }
    } catch (error) {
      if (error instanceof ResourceLimitError) {
        return send(res, 429, { error: error.code, message: error.message })
      }
      recognitionFailure = error instanceof Error ? error.message : '支付截图识别失败'
    }
    const recognized = !recognitionFailure
    const uploadedAt = now()
    subscription.paymentUploadedAt = uploadedAt
    subscription.paymentImages ??= []
    subscription.paymentImages.push({
      id: `PAYIMG-${Date.now()}-${subscription.paymentImages.length + 1}`,
      paymentImageUrl,
      paymentImageName,
      recognizedAmount: Number(recognizedAmount.toFixed(2)),
      uploadedAt,
      status: recognized ? '已识别' : '识别失败'
    })
    subscription.paymentImageUrl = paymentImageUrl
    subscription.paymentImageName = paymentImageName
    const recognizedTotal = Number(subscription.paymentImages
      .filter(item => item.status === '已识别')
      .reduce((sum, item) => sum + item.recognizedAmount, 0).toFixed(2))
    subscription.recognizedPaidAmount = recognizedTotal
    if (recognized) subscription.paymentSuccessAt = uploadedAt
    subscription.pay = subscription.shares !== undefined
      ? '待复核'
      : !recognized
      ? '待复核'
      : recognizedTotal === expectedAmount
        ? '待复核'
        : recognizedTotal < expectedAmount
          ? '部分缴款'
          : '待复核'
    subscription.action = !recognized || recognizedTotal < expectedAmount ? '重新上传截图' : '查看支付'
    await persistState()
    const paymentImageCount = subscription.paymentImages.length
    const remainingAmount = Math.max(0, Number((expectedAmount - recognizedTotal).toFixed(2)))
    const after = {
      status: subscription.pay,
      ocr_status: recognized ? '已识别' : '待财务复核',
      ocr_amount: Number(recognizedAmount.toFixed(2)),
      recognized_total: recognizedTotal,
      expected_amount: expectedAmount,
      remaining_amount: remainingAmount,
      image_count: paymentImageCount,
      confidence: recognized ? 0.98 : 0,
      payment_success_at: recognized ? uploadedAt : undefined,
      reason: recognitionFailure || undefined
    }
    await pushAudit({ actor: 'OCR 适配层', role: 'system', action: 'OCR 支付校验', target: body.paymentId ?? 'PAY-20260705-0092', before: { status: '待识别' }, after })
    return send(res, 200, { data: after, message: recognized ? '支付截图 OCR 识别完成，等待财务审核' : '支付截图已保存，等待财务审核' })
  }

  if (pathname === '/api/settlements/calc') {
    try {
      return send(res, 200, { data: calculateSettlementProfit({
        customerReceiptsCents: body.customerReceiptsCents,
        companyTopUpsCents: body.companyTopUpsCents,
        procurementPaymentsCents: body.procurementPaymentsCents,
        confirmedCostsCents: body.confirmedCostsCents
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
  if (req.method === 'OPTIONS') return send(res, 204, null)
  const url = new URL(req.url, 'http://127.0.0.1:4100')
  try {
    if (req.method === 'GET') return await routeGet(url, req, res)
    if (req.method === 'POST') return await routePost(url.pathname, req, res)
    return send(res, 405, { error: 'METHOD_NOT_ALLOWED' })
  } catch (error) {
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
