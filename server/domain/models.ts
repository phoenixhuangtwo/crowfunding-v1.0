import type { SettlementInvoiceRecord } from '../project-settlement.ts'

export type Role = 'employee' | 'admin' | 'finance' | 'super_admin' | 'system'
export type ProjectStatus = '未开放' | '未满额' | '已满额' | '已截止' | '待回款' | '回款中' | '待分配' | '分配中' | '已中断' | '关闭中' | '已关闭' | '采购失败终止中' | '已终止' | '部分已结算' | '已完结'
export type PaymentStatus = '未缴款' | '部分缴款' | '已缴款' | '待复核' | '复核驳回' | '已收款' | '待确认收款' | '已释放' | '公司待出资' | '待退款' | '待确认退款' | '已退款'
export type Actor = { userId: string; label: string; role: Role }
export type RequestContext = Pick<Actor, 'userId' | 'role'>

export type PaymentImage = {
  id: string
  assetId: string
  paymentImageName: string
  recognizedAmount: number
  uploadedAt: string
  status: '已识别' | '识别失败'
}

export type Project = {
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
  costAmount?: number
  salesAmount?: number
  profitAmount?: number
  companyFixedAmount?: number
  companyTakeoverAmount?: number
  companyBackstopShares?: number
  companyForcedTakeoverAmount?: number
  employeeSubscribedAmount?: number
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
  settlementInvoices?: SettlementInvoiceRecord[]
}

export type Subscription = {
  id: string
  projectId: string
  project: string
  userId: string
  userName?: string
  amount: number
  shares?: number
  companyKind?: 'front' | 'backstop'
  pay: PaymentStatus
  profit: number
  action: string
  idempotencyKey: string
  createdAt: string
  paymentDeadlineAt: string
  paymentUploadedAt?: string
  paymentSuccessAt?: string
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

export type AuditLog = {
  id: string
  time: string
  actor: string
  role: Role
  action: string
  target: string
  before: unknown
  after: unknown
  result: '成功' | '失败'
}

export type RiskEvent = { id: string; projectId?: string; time: string; level: string; desc: string; status: string }

export type SubscriptionRule = {
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

export type ReceivingCode = {
  id: string
  createRequestId?: string
  subject: string
  accountNote: string
  codeName: string
  status: '启用' | '已禁用'
  updatedBy: string
  updatedAt: string
  disabledReason?: string
  imageAssetId?: string
  imageName?: string
}

export type FileAsset = {
  id: string
  provider: 'tencent-cos'
  bucket: string
  region: string
  objectKey: string
  originalName: string
  extension: string
  mimeType: string
  sizeBytes: number
  sha256: string
  purpose: 'receiving-code' | 'payment-proof' | 'settlement-invoice' | 'procurement-payment-proof' | 'customer-receipt-proof' | 'confirmed-cost-proof' | 'distribution-payout-proof' | 'exception-fund-proof' | 'exception-refund-proof' | 'subscription-refund-proof' | 'supplier-refund-proof' | 'receipt-termination-refund-proof'
  ownerType: 'receiving-code' | 'subscription' | 'project'
  ownerId: string
  status: 'pending' | 'ready' | 'failed' | 'pending_delete'
  createdBy: string
  createdAt: string
  updatedAt: string
  lastError?: string
}

export type AppState = {
  projects: Project[]
  subscriptions: Subscription[]
  auditLogs: AuditLog[]
  riskEvents: RiskEvent[]
  rules: SubscriptionRule[]
  receivingCodes: ReceivingCode[]
}
