import type { SettlementInvoiceRecord } from '../project-settlement.ts'

export type Role = 'employee' | 'admin' | 'finance' | 'super_admin' | 'system'
export type ProjectStatus = '未开放' | '未满额' | '已满额' | '已截止' | '已中断' | '部分已结算' | '已完结'
export type PaymentStatus = '未缴款' | '部分缴款' | '已缴款' | '待复核' | '复核驳回' | '已收款' | '待确认收款'
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
  companyForcedTakeoverAmount?: number
  employeeSubscribedAmount?: number
  subscribed: number
  people: number
  interruptReason?: string
  interruptedAt?: string
  refundNotice?: string
  ruleId?: string
  settledAmount?: number
  settlementInvoices?: SettlementInvoiceRecord[]
}

export type Subscription = {
  id: string
  projectId: string
  project: string
  userId: string
  amount: number
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
  reviewedBy?: string
  reviewedAt?: string
  rejectReason?: string
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
  ruleName: string
  totalAmount: number
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
  purpose: 'receiving-code' | 'payment-proof' | 'settlement-invoice'
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
