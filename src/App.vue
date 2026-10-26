<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import {
  ArrowDown,
  Briefcase,
  Checked,
  CreditCard,
  Document,
  Grid,
  Lock,
  Money,
  Tickets,
  Upload,
  User,
  Wallet
} from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { UploadFile, UploadInstance } from 'element-plus'
import { getAdminProjectActionLayout } from './admin-project-actions'
import { validateInvoiceImage } from './invoice-image'
import { filterTargetProjectPaymentReviews } from './payment-review'
import { projectSettlementStatus } from './project-settlement-status'
import { sortProjectsByCreatedAtDesc } from './project-sort'
import { filterSubscriptionRules } from './subscription-rule-filter'
import { settlementPaymentTime, settlementSubscriberLabel } from './settlement-detail'
import { beginSettlement } from './settlement-flow'
import { estimateShareProfit } from './estimated-share-profit'
import { prepareShareRule } from '../server/share-subscription'
import { validatePublishSchedule } from '../server/publish-schedule'
import { apiRequest } from './auth/api-client'
import { readAccessToken } from './auth/session'
import { useAuthSession } from './auth/use-auth-session'
import { allowedPageKeys, canApi, canUi, type AuthorizedPageKey } from './auth/permissions'
import { permissionFor, reviewPermissionFor } from '../server/iam/permissions'
import AuthStateView from './components/AuthStateView.vue'
import ProcurementPaymentPage from './components/ProcurementPaymentPage.vue'
import CustomerReceiptsPage from './components/CustomerReceiptsPage.vue'
import DistributionOrdersPage from './components/DistributionOrdersPage.vue'
import ExceptionFundsPage from './components/ExceptionFundsPage.vue'
import ProjectRefundsPage from './components/ProjectRefundsPage.vue'
import ProcurementFailurePage from './components/ProcurementFailurePage.vue'
import MyPayoutsPage from './components/MyPayoutsPage.vue'

type Role = 'employee' | 'admin' | 'finance' | 'super_admin'
type PageKey =
  | 'projects'
  | 'detail'
  | 'mine'
  | 'myPayouts'
  | 'payment'
  | 'adminProjects'
  | 'rules'
  | 'agreements'
  | 'receivingCode'
  | 'payReview'
  | 'settlement'
  | 'procurementPayment'
  | 'customerReceipts'
  | 'distributionOrders'
  | 'exceptionFunds'
  | 'projectRefunds'
  | 'procurementFailure'
  | 'takeovers'
  | 'rbac'
  | 'audit'
type NavPage = { key: PageKey; label: string; req: 'P0' | 'P1' | 'P2'; icon: unknown; permission: string }
type AgreementVersion = { id: string; version: number; title: string; body: string; effectiveAt: string; createdBy: string; status?: string }
type AgreementConfirmation = { id: string; version: number; userId: string; userName: string; node: string; relatedId: string; confirmedAt: string }
type Project = {
  id: string
  title: string
  source: string
  offlineSalesOrder?: string
  reopenedFromProjectId?: string
  reopenedByProjectId?: string
  createdAt?: string
  projectOwner?: string
  status: '未开放' | '未满额' | '已满额' | '已截止' | '待回款' | '回款中' | '待分配' | '分配中' | '已中断' | '关闭中' | '已关闭' | '采购失败终止中' | '已终止' | '部分已结算' | '已完结'
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
  settlementInvoices?: Array<{
    id: string
    amount: number
    fileName: string
    assetId: string
    imageUrl?: string
    transactionDate: string
    payer: string
    payee: string
    confirmedAt: string
    operator: string
    resultStatus?: '凭证已确认' | '部分已结算' | '已完结'
    settledAmountAfter?: number
    remainingAmountAfter?: number
  }>
}
type PaymentImage = {
  id: string
  assetId: string
  paymentImageUrl?: string
  paymentImageName: string
  recognizedAmount: number
  uploadedAt: string
  status: '已识别' | '识别失败'
}
type InvoiceOcrResult = {
  amount?: number
  taskNo?: string
  settlementProofId?: string
  proofExpiresAt?: number
  assetId?: string
  fileName?: string
  fields: Array<{ key: string; label: string; value: string }>
}
type Subscription = {
  id: string
  projectId?: string
  project: string
  userId?: string
  amount: number
  shares?: number
  pay: string
  profit: number
  action: string
  idempotencyKey?: string
  createdAt?: string
  paymentDeadlineAt?: string
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
type AuditRow = {
  before?: unknown
  after?: unknown
  requestId?: string
  time: string
  actor: string
  action: string
  target: string
  result: string
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
  companyFixedAmount?: number
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
type RuleForm = {
  projectId: string
  ruleName: string
  totalAmount: number | undefined
  sharePrice: number | undefined
  companyFrontShares: number | undefined
  maxSharesPerEmployee: number | undefined
  companyFixedAmount: number | undefined
  minAmount: number | undefined
  minParticipants: number | undefined
  receivingCodeId: string
  allowMultiple: boolean
  companyTakeover: boolean
  status: '未启用' | '已启用' | '已停用'
  startAt: string
  endAt: string
  paymentCutoffAt?: string
  plannedPaymentDate?: string
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
  imageAssetId?: string
  imageUrl?: string
  imageName?: string
}
type ProcurementOrderDetail = {
  id: string
  projectName: string
  sellOrder: string
  purchasingName: string
  purchasingStatus: string
  projectType: string
  purchasingType: string
  purchaseQuantity: number
  totalCostPrice: number
  totalSellingPrice: number
  totalTransactionPrice: number
  responsiblePerson: string
  purchasingTime: string
  deliveryRequirements: string
  designRequirements: string
  remark: string
  purchasingRemark: string
}

const roles: Record<Role, { label: string; account: string; home: PageKey }> = {
  employee: { label: '员工', account: 'employee01', home: 'projects' },
  admin: { label: '管理员', account: 'admin01', home: 'adminProjects' },
  finance: { label: '财务', account: 'finance01', home: 'receivingCode' },
  super_admin: { label: '公司超级管理员', account: 'superadmin01', home: 'adminProjects' }
}

const navGroups: Array<{ title: string; pages: NavPage[] }> = [
  {
    title: '员工端',
    pages: [
      { key: 'projects', label: '项目列表', req: 'P0', icon: Briefcase, permission: 'crowdfunding:project:query' },
      { key: 'mine', label: '我的认购', req: 'P0', icon: Wallet, permission: 'crowdfunding:subscription:query' },
      { key: 'myPayouts', label: '我的收益', req: 'P0', icon: Wallet, permission: 'crowdfunding:payout:my-query' }
    ]
  },
  {
    title: '项目管理端',
    pages: [
      { key: 'adminProjects', label: '项目管理', req: 'P0', icon: Checked, permission: 'crowdfunding:project:manage' },
      { key: 'rules', label: '认购规则配置', req: 'P0', icon: Document, permission: 'crowdfunding:rule:query' },
      { key: 'agreements', label: '免责协议版本', req: 'P0', icon: Document, permission: 'crowdfunding:agreement:manage' },
      { key: 'receivingCode', label: '项目收款码管理', req: 'P0', icon: CreditCard, permission: 'crowdfunding:receiving-code:query' },
      { key: 'rbac', label: '权限管理', req: 'P0', icon: Lock, permission: 'crowdfunding:access' },
      { key: 'audit', label: '审计日志', req: 'P0', icon: User, permission: 'crowdfunding:audit:query' }
    ]
  },
  {
    title: '财务端',
    pages: [
      { key: 'payReview', label: '支付复核', req: 'P0', icon: Tickets, permission: 'crowdfunding:payment-review:query' },
      { key: 'procurementPayment', label: '采购付款登记', req: 'P0', icon: Money, permission: 'crowdfunding:procurement-payment:register' },
      { key: 'customerReceipts', label: '客户回款', req: 'P0', icon: Money, permission: 'crowdfunding:receipt:query' },
      { key: 'distributionOrders', label: '利润分配', req: 'P0', icon: Money, permission: 'crowdfunding:distribution:query' },
      { key: 'exceptionFunds', label: '异常款项', req: 'P0', icon: Money, permission: 'crowdfunding:exception-fund:query' },
      { key: 'projectRefunds', label: '项目退款', req: 'P0', icon: Money, permission: 'crowdfunding:project-refund:query' },
      { key: 'procurementFailure', label: '采购失败终止', req: 'P1', icon: Money, permission: 'crowdfunding:procurement-failure:query' },
      { key: 'settlement', label: '发票凭证核对', req: 'P0', icon: Money, permission: 'crowdfunding:settlement:query' }
    ]
  }
]

const pageTitleMap: Record<PageKey, string> = {
  projects: '项目列表',
  detail: '项目详情 / 认购',
  mine: '我的认购',
  myPayouts: '我的收益',
  payment: '支付收款码与 OCR',
  adminProjects: '项目管理',
  rules: '认购规则配置',
  agreements: '免责协议版本',
  receivingCode: '项目收款码管理',
  payReview: '支付复核',
  settlement: '发票凭证核对',
  procurementPayment: '采购付款登记',
  customerReceipts: '客户回款',
  distributionOrders: '利润分配',
  exceptionFunds: '异常款项',
  projectRefunds: '项目退款',
  procurementFailure: '采购失败终止',
  takeovers: '公司兜底管理',
  rbac: '权限管理',
  audit: '审计日志'
}

const currentRole = ref<Role>('employee')
const currentPage = ref<PageKey | ''>('')
const authSession = useAuthSession()
const agreementVisible = ref(false)
const currentAgreement = ref<AgreementVersion | null>(null)
const agreementNode = ref<'提交认购' | '查看缴款码' | '确认收款'>('提交认购')
const agreementReadToEnd = ref(false)
const agreementBodyElement = ref<HTMLElement>()
const acceptedAgreementVersion = ref<number>()
let agreementResolver: ((accepted: boolean) => void) | undefined
const agreementVersions = ref<AgreementVersion[]>([])
const agreementVersionTotal = ref(0)
const agreementVersionPage = ref(1)
const agreementFormVisible = ref(false)
const agreementForm = reactive({ title: '', body: '' })
const agreementConfirmations = ref<AgreementConfirmation[]>([])
const agreementConfirmationVersion = ref<number>()
const agreementConfirmationPage = ref(1)
const agreementConfirmationTotal = ref(0)
const agreementConfirmationFilters = reactive({ userId: '', node: '', dates: [] as string[] })
const subscribeVisible = ref(false)
const auditVisible = ref(false)
const selectedAudit = ref<AuditRow | null>(null)
const formatAuditValue = (value: unknown) => value === undefined ? '未记录' : JSON.stringify(value, null, 2)
const ruleDrawerVisible = ref(false)
const ruleCreateVisible = ref(false)
const receivingCodeCreateVisible = ref(false)
const receivingCodeImageVisible = ref(false)
const interruptVisible = ref(false)
const openProjectVisible = ref(false)
const procurementDetailVisible = ref(false)
const procurementDetailLoading = ref(false)
const procurementDetailError = ref('')
const procurementOrderDetail = ref<ProcurementOrderDetail>()
const ocrState = ref<'none' | 'loading' | 'ok' | 'mismatch' | 'fail'>('none')
const paymentUploadRef = ref<UploadInstance>()
const localPaymentImageUrl = ref('')
const lastOcrResult = ref<{ recognizedTotal: number; remainingAmount: number; imageCount: number }>()
const invoiceOcrState = ref<'none' | 'loading' | 'ok' | 'fail'>('none')
const invoiceImageUrl = ref('')
const invoiceImageName = ref('')
const invoiceImageFile = ref<File>()
const invoiceOcrResult = ref<InvoiceOcrResult>()
const invoiceOcrError = ref('')
const invoicePreviewVisible = ref(false)
const invoiceOcrRequestId = ref(0)
const invoiceDeleting = ref(false)
const settlementInvoiceVisible = ref(false)
const invoiceSettlementKey = ref('')
const settlementSubmitting = ref(false)
const listState = ref<'normal' | 'empty' | 'loading' | 'error'>('normal')
const subscribeAmount = ref<number | undefined>(12000)
const subscribeShares = ref<number | undefined>(1)
const reviewActualPaidAmount = ref<number | undefined>()
const reviewTransactionNo = ref('')
const selectedProjectId = ref('PRJ-20260701-003')
const activePaymentSubscriptionId = ref('')
const projectPage = ref(1)
const projectPageSize = ref(10)
const adminProjectPage = ref(1)
const adminProjectPageSize = 10
const rulePage = ref(1)
const rulePageSize = ref(10)
const projectSort = reactive<{ prop: string; order: 'ascending' | 'descending' | null }>({ prop: '', order: null })
const adminProjectKeyword = ref('')
const adminProjectStatus = ref<Project['status'] | '全部'>('全部')
const adminSettlementStatus = ref<ReturnType<typeof projectSettlementStatus> | '全部'>('全部')
const interruptReason = ref('')
const interruptProjectId = ref('')
const interruptProjectTitle = ref('')
const openProjectId = ref('')
const openProjectTitle = ref('')
const selectedOpenRuleId = ref('')
const editingRuleId = ref('')
const ruleReadonly = ref(false)
const receivingCodeForm = reactive({
  subject: 'XX 科技有限公司',
  accountNote: '支付宝收款码 · 财务专用',
  codeName: '支付宝收款码'
})
const receivingCodeImageUrl = ref('')
const receivingCodeImageName = ref('')
const receivingCodeImageFile = ref<File>()
const receivingCodeCreateRequestId = ref('')
const receivingCodeSubmitting = ref(false)
const receivingCodeUploadRef = ref<UploadInstance>()
const receivingCodeImageUploadRef = ref<UploadInstance>()
const editingReceivingCodeId = ref('')
const editingReceivingCodeImageUrl = ref('')
const editingReceivingCodeImageName = ref('')
const editingReceivingCodeImageFile = ref<File>()
const projectFilters = reactive({ status: '全部', subscriptionStatus: '全部', subscriptionCount: undefined as number | undefined, keyword: '' })
const mineFilters = reactive({
  keyword: '',
  project: '全部',
  pay: '全部',
  minAmount: undefined as number | undefined,
  maxAmount: undefined as number | undefined
})
const ruleFilters = reactive({ keyword: '', projectId: '全部', status: '全部' })
const receivingCodeFilters = reactive({ keyword: '', status: '全部' })
const auditFilters = reactive({ actor: '', result: '全部' as '全部' | '成功' | '失败' })
const createEmptyRuleForm = (): RuleForm => ({
  projectId: '',
  ruleName: '',
  totalAmount: undefined,
  sharePrice: undefined,
  companyFrontShares: 0,
  maxSharesPerEmployee: undefined,
  companyFixedAmount: undefined,
  minAmount: undefined,
  minParticipants: undefined,
  receivingCodeId: '',
  allowMultiple: false,
  companyTakeover: false,
  status: '未启用',
  startAt: '',
  endAt: '',
  paymentCutoffAt: '',
  plannedPaymentDate: ''
})
const ruleForm = reactive<RuleForm>(createEmptyRuleForm())

const projects = reactive<Project[]>([
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
  }
])

const mockReviewSubscriptions: Subscription[] = Array.from({ length: 20 }, (_, index) => {
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
    paymentUploadedAt: `2026-07-${day} ${hour}:${minute}:00`,
    paymentSuccessAt: `2026-07-${day} ${hour}:${String(Math.max(0, Number(minute) - 2)).padStart(2, '0')}:18`
  }
})

const subscriptions = reactive<Subscription[]>([
  { id: 'SUB-20260705-0031', project: '2026-Q3 办公设备集采认购', amount: 12000, pay: '待复核', profit: 984, action: '查看支付' },
  { id: 'SUB-20260704-0027', project: '员工餐厅冷链设备升级', amount: 6000, pay: '未缴款', profit: 492, action: '去支付' },
  { id: 'SUB-20260412-0006', project: '2026-Q2 IT 外设集采', amount: 18000, pay: '待确认收款', profit: 3640, action: '确认收款' },
  { id: 'SUB-MOCK-WJK-001', projectId: 'PRJ-MOCK-WME-001', project: '样例认购 · 未缴款 01', amount: 3200, pay: '未缴款', profit: 260, action: '去支付', paymentDeadlineAt: '2026-08-28 09:00' },
  { id: 'SUB-MOCK-WJK-002', projectId: 'PRJ-MOCK-WME-002', project: '样例认购 · 未缴款 02', amount: 8800, pay: '未缴款', profit: 720, action: '去支付', paymentDeadlineAt: '2026-08-28 09:15' },
  { id: 'SUB-MOCK-WJK-003', projectId: 'PRJ-MOCK-WKF-002', project: '样例认购 · 未缴款 03', amount: 5200, pay: '未缴款', profit: 426, action: '去支付', paymentDeadlineAt: '2026-08-28 09:30' },
  { id: 'SUB-MOCK-WJK-004', projectId: 'PRJ-MOCK-YWJ-002', project: '样例认购 · 未缴款 04', amount: 7600, pay: '未缴款', profit: 623, action: '去支付', paymentDeadlineAt: '2026-08-28 09:45' },
  { id: 'SUB-MOCK-WJK-005', projectId: 'PRJ-MOCK-WME-007', project: '样例认购 · 未缴款 05', amount: 4100, pay: '未缴款', profit: 336, action: '去支付', paymentDeadlineAt: '2026-08-28 10:00' },
  { id: 'SUB-MOCK-WJK-006', projectId: 'PRJ-MOCK-WME-001', project: '样例认购 · 未缴款 06', amount: 4600, pay: '未缴款', profit: 377, action: '去支付', paymentDeadlineAt: '2026-08-28 10:15' },
  { id: 'SUB-MOCK-WJK-007', projectId: 'PRJ-MOCK-WME-002', project: '样例认购 · 未缴款 07', amount: 5900, pay: '未缴款', profit: 484, action: '去支付', paymentDeadlineAt: '2026-08-28 10:30' },
  { id: 'SUB-MOCK-WJK-008', projectId: 'PRJ-MOCK-WKF-002', project: '样例认购 · 未缴款 08', amount: 6800, pay: '未缴款', profit: 558, action: '去支付', paymentDeadlineAt: '2026-08-28 10:45' },
  { id: 'SUB-MOCK-WJK-009', projectId: 'PRJ-MOCK-YWJ-002', project: '样例认购 · 未缴款 09', amount: 7900, pay: '未缴款', profit: 648, action: '去支付', paymentDeadlineAt: '2026-08-28 11:00' },
  { id: 'SUB-MOCK-WJK-010', projectId: 'PRJ-MOCK-WME-007', project: '样例认购 · 未缴款 10', amount: 9500, pay: '未缴款', profit: 779, action: '去支付', paymentDeadlineAt: '2026-08-28 11:15' },
  { id: 'SUB-MOCK-DFH-001', project: '样例认购 · 待复核 A', amount: 5600, pay: '待复核', profit: 458, action: '查看支付', paymentUploadedAt: '2026-07-07 10:18' },
  { id: 'SUB-MOCK-DFH-002', project: '样例认购 · 待复核 B', amount: 9300, pay: '待复核', profit: 762, action: '查看支付', paymentUploadedAt: '2026-07-07 11:06' },
  { id: 'SUB-MOCK-BH-001', project: '样例认购 · 复核驳回 A', amount: 4200, pay: '复核驳回', profit: 344, action: '重新上传截图', paymentUploadedAt: '2026-07-07 12:22', rejectReason: '支付截图缺少交易单号，无法与认购记录完成匹配，请重新上传包含支付成功页、金额、交易流水和收款方信息的截图。' },
  { id: 'SUB-MOCK-BH-002', project: '样例认购 · 复核驳回 B', amount: 7600, pay: '复核驳回', profit: 623, action: '重新上传截图', paymentUploadedAt: '2026-07-07 13:40', rejectReason: 'OCR 识别金额与申请认购金额不一致，截图疑似为其他付款记录，请重新支付或上传正确的支付成功截图。' },
  { id: 'SUB-MOCK-SK-001', project: '样例认购 · 待确认收款 A', amount: 10400, pay: '待确认收款', profit: 853, action: '确认收款', paymentUploadedAt: '2026-07-07 14:25' },
  { id: 'SUB-MOCK-SK-002', project: '样例认购 · 待确认收款 B', amount: 15800, pay: '待确认收款', profit: 1295, action: '确认收款', paymentUploadedAt: '2026-07-07 15:10' },
  ...mockReviewSubscriptions
])

const receivingCodes = reactive<ReceivingCode[]>([
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
])

const auditRows = reactive<AuditRow[]>([
  { time: '2026-07-05 10:32:01', actor: '张明 · 员工', action: '上传支付截图', target: 'PAY-20260705-0092', result: '成功' },
  { time: '2026-07-04 16:08:45', actor: '周敏 · 财务', action: '支付复核 · 驳回', target: 'PAY-20260703-0087', result: '成功' },
  { time: '2026-07-02 10:00:12', actor: '周敏 · 财务', action: '替换收款码', target: 'PRJ-20260701-003', result: '成功' },
  { time: '2026-06-30 18:00:03', actor: '系统', action: '自动兜底接管', target: 'TKV-20260430-01', result: '成功' }
])
const rules = reactive<SubscriptionRule[]>([])
// Authenticated pages must not briefly present the old local demo records as real business data.
projects.splice(0)
subscriptions.splice(0)
receivingCodes.splice(0)
auditRows.splice(0)

const pageTitle = computed(() => currentPage.value ? pageTitleMap[currentPage.value] : '暂无可用页面')
const limitedAdmin = computed(() => currentRole.value === 'admin' && authSession.permissionInfo.value?.dataScope?.all !== true)
const hiddenNavPageKeys = new Set<PageKey>(['payReview', 'settlement', 'rbac'])
const authorizedPageKeys = computed(() => new Set(allowedPageKeys(authSession.permissionInfo.value)))
const visibleNavGroups = computed(() => navGroups.map(group => ({
  ...group,
  pages: group.pages.filter(page => (!limitedAdmin.value || page.key === 'adminProjects' || page.key === 'procurementFailure')
    && !hiddenNavPageKeys.has(page.key) && authorizedPageKeys.value.has(page.key as AuthorizedPageKey)
    && canUi(authSession.permissionInfo.value, page.permission))
})).filter(group => group.pages.length > 0))
const selectedProject = computed(() => projects.find(project => project.id === selectedProjectId.value) ?? projects[0])
const selectedProjectRule = computed(() => {
  const project = selectedProject.value
  if (!project) return undefined
  return rules.find(rule => rule.id === project.ruleId)
    ?? rules.find(rule => rule.projectId === project.id && rule.status === '已启用')
    ?? rules.find(rule => rule.projectId === project.id && rule.status !== '已停用')
})
const selectedProjectMinAmount = computed(() => selectedProjectRule.value?.minAmount ?? 100)
const selectedProjectShareRule = computed(() => selectedProjectRule.value?.sharePrice ? selectedProjectRule.value : undefined)
const shareRemaining = computed(() => selectedProject.value && selectedProjectShareRule.value
  ? Math.floor(Math.round(projectRemainAmount(selectedProject.value) * 100) / Math.round(selectedProjectShareRule.value.sharePrice! * 100)) : 0)
const employeeHeldShares = computed(() => subscriptions
  .filter(item => item.projectId === selectedProject.value?.id && item.userId === roleMeta.value.account)
  .reduce((sum, item) => sum + (item.shares ?? 0), 0))
const shareAvailable = computed(() => selectedProjectShareRule.value?.allowMultiple === false && employeeHeldShares.value > 0
  ? 0
  : Math.max(0, Math.min(shareRemaining.value,
    (selectedProjectShareRule.value?.maxSharesPerEmployee ?? 0) - employeeHeldShares.value)))
const shareDeadlineOpen = computed(() => !selectedProjectShareRule.value || new Date(selectedProject.value.deadline.replace(' ', 'T')).getTime() >= Date.now())
const effectiveSubscribeAmount = computed(() => selectedProjectShareRule.value
  ? Number(((subscribeShares.value ?? 0) * selectedProjectShareRule.value.sharePrice!).toFixed(2))
  : subscribeAmount.value ?? 0)
const selectedShareEstimatedProfit = computed(() => selectedProjectShareRule.value && selectedProject.value
  ? estimateShareProfit({
    salesAmount: selectedProject.value.salesAmount,
    costAmount: selectedProject.value.costAmount,
    totalShares: selectedProjectShareRule.value.totalShares,
    shares: subscribeShares.value
  }) : null)
const subscribeAmountMax = computed(() => Math.max(selectedProjectMinAmount.value, selectedProject.value ? projectRemainAmount(selectedProject.value) : selectedProjectMinAmount.value))
const canSubscribe = computed(() => Boolean(selectedProject.value?.status === '未满额' && shareDeadlineOpen.value && (
  selectedProjectShareRule.value
    ? Number.isInteger(subscribeShares.value ?? NaN) && (subscribeShares.value ?? 0) >= 1 && (subscribeShares.value ?? 0) <= shareAvailable.value
    : subscribeAmount.value && subscribeAmount.value >= selectedProjectMinAmount.value && subscribeAmount.value <= projectRemainAmount(selectedProject.value)
)))
const settlementProjectSubscriptions = computed(() => subscriptions.filter(subscription => isProjectSubscription(selectedProject.value, subscription)))
const selectedProjectSettledAmount = computed(() => Number((selectedProject.value?.settledAmount ?? 0).toFixed(2)))
const selectedProjectRemainingSettlementAmount = computed(() => Number(Math.max(0, projectSalesAmount(selectedProject.value) - selectedProjectSettledAmount.value).toFixed(2)))
const selectedProjectSettlementCompleted = computed(() => selectedProject.value?.status === '已完结' || selectedProjectRemainingSettlementAmount.value === 0)
const currentInvoiceAmount = computed(() => invoiceOcrResult.value?.amount)
const currentInvoiceCanConfirm = computed(() => currentInvoiceAmount.value !== undefined
  && currentInvoiceAmount.value > 0
  && currentInvoiceAmount.value <= selectedProjectRemainingSettlementAmount.value
  && !invoiceDeleting.value
  && !selectedProjectSettlementCompleted.value)
const currentInvoiceExceedsRemaining = computed(() => currentInvoiceAmount.value !== undefined
  && currentInvoiceAmount.value > selectedProjectRemainingSettlementAmount.value)
const roleMeta = computed(() => ({ ...roles[currentRole.value], account: authSession.permissionInfo.value?.user.id ?? '' }))
const ruleDialogTitle = computed(() => ruleReadonly.value ? '查看认购规则配置' : editingRuleId.value ? '修改认购规则' : '创建认购规则')
const openRuleOptions = computed(() => rules.filter(rule => rule.status === '已启用'))
const selectedOpenRule = computed(() => openRuleOptions.value.find(rule => rule.id === selectedOpenRuleId.value))
const selectedRuleProject = computed(() => projects.find(project => project.id === ruleForm.projectId))
const enabledReceivingCodes = computed(() => receivingCodes.filter(code => code.status === '启用'))
const selectedRuleReceivingCode = computed(() => receivingCodes.find(code => code.id === ruleForm.receivingCodeId))
const editingRule = computed(() => rules.find(rule => rule.id === editingRuleId.value))
const isShareRuleForm = computed(() => Boolean(ruleForm.sharePrice) || (!editingRule.value && !ruleReadonly.value))
const ruleProjectIds = computed(() => new Set(rules.map(rule => rule.projectId)))
const isRuleProjectOptionDisabled = (projectId: string) => {
  return ruleProjectIds.value.has(projectId) && editingRule.value?.projectId !== projectId
}
const ruleFormLockedBySubscriptions = computed(() => editingRule.value ? isRuleLocked(editingRule.value) : hasRealUserSubscriptions(ruleForm.projectId))
const derivedRuleTotalAmount = computed(() => {
  const project = selectedRuleProject.value
  if (!project) return 0
  if (isShareRuleForm.value && ruleForm.sharePrice && ruleForm.companyFrontShares !== undefined) {
    return Math.max(0, projectCostAmount(project) - ruleForm.sharePrice * ruleForm.companyFrontShares)
  }
  return Math.max(0, projectCostAmount(project) - Number(ruleForm.companyFixedAmount ?? 0))
})
const derivedRuleMinAmount = computed(() => {
  if (isShareRuleForm.value) return ruleForm.sharePrice ?? 0
  const participants = Number(ruleForm.minParticipants ?? 0)
  return participants > 0 ? Math.ceil(derivedRuleTotalAmount.value / participants) : 0
})
const ruleTimeRange = computed<[string, string] | []>({
  get() {
    return ruleForm.startAt && ruleForm.endAt ? [ruleForm.startAt, ruleForm.endAt] : []
  },
  set(value) {
    ruleForm.startAt = value?.[0] ?? ''
    ruleForm.endAt = value?.[1] ?? ''
  }
})
const subscriptionProjectOptions = computed(() => Array.from(new Set(subscriptions.map(item => item.project))))
const paymentReviewSubscriptions = computed(() => {
  const project = selectedProject.value
  if (!project) return []
  return filterTargetProjectPaymentReviews(subscriptions, project)
})
const activePaymentSubscription = computed(() => {
  return subscriptions.find(item => item.id === activePaymentSubscriptionId.value && !['已释放', '缴款逾期'].includes(subscriptionDisplayPay(item)))
    ?? subscriptions.find(item => !['待确认收款', '已收款', '已释放', '缴款逾期'].includes(subscriptionDisplayPay(item)))
})
const activePaymentAmount = computed(() => activePaymentSubscription.value?.amount ?? 12000)
const activePaymentImages = computed<PaymentImage[]>(() => {
  const subscription = activePaymentSubscription.value
  if (!subscription) return []
  return subscription.paymentImages ?? []
})
const activePaymentRecognizedAmount = computed(() => Number((activePaymentSubscription.value?.recognizedPaidAmount
  ?? activePaymentImages.value.filter(image => image.status === '已识别').reduce((sum, image) => sum + image.recognizedAmount, 0)).toFixed(2)))
const activePaymentRemainingAmount = computed(() => Math.max(0, Number((activePaymentAmount.value - activePaymentRecognizedAmount.value).toFixed(2))))
const paymentRecognitionComplete = computed(() => activePaymentRecognizedAmount.value >= activePaymentAmount.value)
const activePaymentProject = computed(() => {
  const subscription = activePaymentSubscription.value
  if (!subscription) return undefined
  return projects.find(project => isProjectSubscription(project, subscription))
})
const activePaymentRule = computed(() => {
  const project = activePaymentProject.value
  if (!project) return undefined
  const rule = rules.find(item => item.id === project.ruleId)
    ?? rules.find(item => item.projectId === project.id && item.status === '已启用')
  return rule?.status === '已启用' ? rule : undefined
})
const activePaymentReceivingCode = computed(() => {
  const receivingCodeId = activePaymentRule.value?.receivingCodeId
  if (!receivingCodeId) return undefined
  return receivingCodes.find(code => code.id === receivingCodeId && code.status === '启用')
})
const activePaymentReceivingCodeEmptyText = computed(() => {
  if (!activePaymentProject.value) return '当前认购记录未关联到有效项目，请联系管理员处理。'
  if (!activePaymentRule.value) return '当前项目未配置已启用的认购规则，请联系管理员处理。'
  if (!activePaymentRule.value.receivingCodeId) return '当前项目规则尚未绑定收款码，请联系管理员或财务处理。'
  return '当前项目绑定的收款码不可用，请联系管理员或财务处理。'
})
const activeReviewSubscription = computed(() => {
  return paymentReviewSubscriptions.value.find(item => item.id === activePaymentSubscriptionId.value)
    ?? paymentReviewSubscriptions.value[0]
})
const activeReviewPaymentImages = computed(() => activeReviewSubscription.value?.paymentImages ?? [])
const activeReviewProject = computed(() => {
  const subscription = activeReviewSubscription.value
  return subscription
    ? projects.find(project => project.id === subscription.projectId || project.title === subscription.project)
    : undefined
})
const activeReviewProjectName = computed(() => activeReviewProject.value?.title ?? activeReviewSubscription.value?.project ?? '-')
const activeReviewProjectCode = computed(() => activeReviewProject.value?.id ?? activeReviewSubscription.value?.projectId ?? '-')
const paymentReviewTargetLabel = computed(() => selectedProject.value ? `${selectedProject.value.title}（${selectedProject.value.id}）` : '未选择目标项目')
const activeReviewAmount = computed(() => activeReviewSubscription.value?.amount ?? 12000)
const activeReviewRecognizedAmount = computed(() => Number((activeReviewSubscription.value?.recognizedPaidAmount
  ?? activeReviewPaymentImages.value.filter(image => image.status === '已识别').reduce((sum, image) => sum + image.recognizedAmount, 0)).toFixed(2)))
const pendingPaymentReviewCount = computed(() => paymentReviewSubscriptions.value.filter(item => subscriptionDisplayPay(item) === '待复核').length)
const activeReviewIsPending = computed(() => activeReviewSubscription.value ? subscriptionDisplayPay(activeReviewSubscription.value) === '待复核' : false)
const activeReviewReadOnlyText = computed(() => activeReviewSubscription.value
  ? `当前记录状态为“${subscriptionPayLabel(activeReviewSubscription.value)}”，仅供查看，不能重复复核。`
  : '当前没有可查看的缴款记录。')
const activeReviewPaymentId = computed(() => activeReviewSubscription.value ? reviewPaymentId(activeReviewSubscription.value) : 'PAY-20260705-0092')
const employeeNameMap: Record<string, string> = {
  employee01: '张明',
  employee02: '赵倩'
}
const activeReviewEmployeeLabel = computed(() => {
  const userId = activeReviewSubscription.value?.userId ?? 'employee01'
  return `${userId} · ${employeeNameMap[userId] ?? '员工'}`
})
const activeReviewUploadedAt = computed(() => activeReviewSubscription.value?.paymentUploadedAt ?? '2026-07-05 10:32:01')
const activeReviewPaymentSuccessAt = computed(() => activeReviewSubscription.value?.paymentSuccessAt ?? '2026-07-05 10:30:18')
const activeReviewReviewedBy = computed(() => activeReviewSubscription.value?.reviewedBy ?? '-')
const activeReviewReviewedAt = computed(() => activeReviewSubscription.value?.reviewedAt ?? '-')
const filteredSubscriptions = computed(() => subscriptions.filter(subscription => {
  if (isCompanySubscription(subscription) || subscription.userId !== roleMeta.value.account) return false
  const keyword = mineFilters.keyword.trim()
  const keywordMatched = !keyword || [subscription.id, subscription.project].some(value => value.includes(keyword))
  const projectMatched = mineFilters.project === '全部' || subscription.project === mineFilters.project
  const payMatched = mineFilters.pay === '全部' || subscriptionDisplayPay(subscription) === mineFilters.pay
  const minMatched = mineFilters.minAmount === undefined || subscription.amount >= mineFilters.minAmount
  const maxMatched = mineFilters.maxAmount === undefined || subscription.amount <= mineFilters.maxAmount
  return keywordMatched && projectMatched && payMatched && minMatched && maxMatched
}))
const sortedSubscriptions = computed(() => [...filteredSubscriptions.value].sort((left, right) => {
  const leftUnpaid = subscriptionDisplayPay(left) === '未缴款'
  const rightUnpaid = subscriptionDisplayPay(right) === '未缴款'
  if (leftUnpaid && rightUnpaid) return getDateTime(left.paymentDeadlineAt, Number.MAX_SAFE_INTEGER) - getDateTime(right.paymentDeadlineAt, Number.MAX_SAFE_INTEGER)
  if (leftUnpaid !== rightUnpaid) return leftUnpaid ? -1 : 1
  return getDateTime(right.paymentUploadedAt, 0) - getDateTime(left.paymentUploadedAt, 0)
}))
const filteredReceivingCodes = computed(() => receivingCodes.filter(code => {
  const keyword = receivingCodeFilters.keyword.trim()
  const keywordMatched = !keyword || [
    code.id,
    code.subject,
    code.accountNote,
    code.codeName,
    code.status,
    code.updatedBy,
    code.updatedAt,
    code.disabledReason ?? ''
  ].some(value => value.includes(keyword))
  const statusMatched = receivingCodeFilters.status === '全部' || code.status === receivingCodeFilters.status
  return keywordMatched && statusMatched
}))

function getDateTime(value?: string, fallback = 0) {
  if (!value) return fallback
  const timestamp = new Date(value.replace(' ', 'T')).getTime()
  return Number.isNaN(timestamp) ? fallback : timestamp
}

function getProjectDeadlineTime(project: Project) {
  return new Date(project.deadline.replace(' ', 'T')).getTime()
}

function handleProjectSortChange({ prop, order }: { prop: string; order: 'ascending' | 'descending' | null }) {
  projectSort.prop = prop
  projectSort.order = order
  projectPage.value = 1
  adminProjectPage.value = 1
}

const filteredProjects = computed(() => projects.filter(project => {
  const keyword = projectFilters.keyword.trim()
  const statusMatched = projectFilters.status === '全部' || project.status === projectFilters.status
  const subscriptionStatusMatched = projectFilters.subscriptionStatus === '全部' || getProjectSubscriptionStatus(project.id) === projectFilters.subscriptionStatus
  const subscriptionCountMatched = projectFilters.subscriptionCount === undefined || getProjectSubscriptionCount(project.id) === projectFilters.subscriptionCount
  const keywordMatched = !keyword || [project.title, project.id, project.source].some(value => value.includes(keyword))
  return statusMatched && subscriptionStatusMatched && subscriptionCountMatched && keywordMatched
}).sort((left, right) => {
  if (projectSort.prop === 'subscriptionProgress' && projectSort.order) {
    const direction = projectSort.order === 'ascending' ? 1 : -1
    return (projectProgressPercent(left) - projectProgressPercent(right)) * direction
  }
  if (projectSort.prop === 'deadline' && projectSort.order) {
    const direction = projectSort.order === 'ascending' ? 1 : -1
    return (getProjectDeadlineTime(left) - getProjectDeadlineTime(right)) * direction
  }
  if (projectSort.prop === 'remainingAmount' && projectSort.order) {
    const direction = projectSort.order === 'ascending' ? 1 : -1
    return (projectRemainAmount(left) - projectRemainAmount(right)) * direction
  }
  return getProjectDeadlineTime(left) - getProjectDeadlineTime(right)
}))
const pagedProjects = computed(() => {
  const start = (projectPage.value - 1) * projectPageSize.value
  return filteredProjects.value.slice(start, start + projectPageSize.value)
})
const filteredRules = computed(() => filterSubscriptionRules(rules, ruleFilters))
const pagedRules = computed(() => {
  const start = (rulePage.value - 1) * rulePageSize.value
  return filteredRules.value.slice(start, start + rulePageSize.value)
})
const filteredAdminProjects = computed(() => {
  const keyword = adminProjectKeyword.value.trim()
  const matchedProjects = projects.filter(project => {
    const statusMatched = adminProjectStatus.value === '全部' || project.status === adminProjectStatus.value
    const settlementStatusMatched = adminSettlementStatus.value === '全部' || projectSettlementStatus(project.status) === adminSettlementStatus.value
    const keywordMatched = !keyword || [
      '项目',
      '项目状态',
      '结算状态',
      '项目成本金额',
      '项目销售金额',
      '项目利润',
      '开放认购金额',
      '开放认购比例',
      '认购状态',
      '认购笔数',
      '认购进度',
      '剩余可认购金额',
      '截止认购时间',
      project.title,
      project.id,
      project.offlineSalesOrder ?? '',
      project.createdAt ?? '',
      project.status,
      projectSettlementStatus(project.status),
      getProjectSubscriptionStatus(project.id),
      String(getProjectSubscriptionCount(project.id)),
      `${projectProgressPercent(project)}%`,
      formatMoney(projectRemainAmount(project)),
      project.deadline,
      formatMoney(projectCostAmount(project)),
      formatMoney(projectSalesAmount(project)),
      formatMoney(projectProfitAmount(project)),
      formatMoney(project.total),
      `${projectOpenRatio(project)}%`,
      String(projectCostAmount(project)),
      String(projectSalesAmount(project)),
      String(projectProfitAmount(project)),
      String(project.total)
    ].some(value => value.includes(keyword))
    return statusMatched && settlementStatusMatched && keywordMatched
  })
  if (projectSort.prop === 'subscriptionProgress' && projectSort.order) {
    const direction = projectSort.order === 'ascending' ? 1 : -1
    return [...matchedProjects].sort((left, right) => (projectProgressPercent(left) - projectProgressPercent(right)) * direction)
  }
  if (projectSort.prop === 'deadline' && projectSort.order) {
    const direction = projectSort.order === 'ascending' ? 1 : -1
    return [...matchedProjects].sort((left, right) => (getProjectDeadlineTime(left) - getProjectDeadlineTime(right)) * direction)
  }
  if (projectSort.prop === 'remainingAmount' && projectSort.order) {
    const direction = projectSort.order === 'ascending' ? 1 : -1
    return [...matchedProjects].sort((left, right) => (projectRemainAmount(left) - projectRemainAmount(right)) * direction)
  }
  return sortProjectsByCreatedAtDesc(matchedProjects)
})
const pagedAdminProjects = computed(() => {
  const start = (adminProjectPage.value - 1) * adminProjectPageSize
  return filteredAdminProjects.value.slice(start, start + adminProjectPageSize)
})

watch([adminProjectKeyword, adminProjectStatus, adminSettlementStatus], () => {
  adminProjectPage.value = 1
})
const filteredAuditRows = computed(() => {
  const actorKeyword = auditFilters.actor.trim()
  const resultFilter = auditFilters.result
  return auditRows.filter(row => {
    const actorMatched = !actorKeyword || row.actor.includes(actorKeyword)
    const resultMatched = resultFilter === '全部' || row.result === resultFilter
    return actorMatched && resultMatched
  })
})

async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const code = permissionFor(options?.method ?? 'GET', new URL(path, window.location.origin).pathname)
  if (!canApi(authSession.permissionInfo.value, code)) throw new Error('暂无执行该操作的权限')
  return apiRequest<T>(path, options)
}

const privateImageCache = new Map<string, string>()

async function privateImageUrl(assetId?: string) {
  if (!assetId) return ''
  const cached = privateImageCache.get(assetId)
  if (cached) return cached
  const response = await fetch(`/api/files/${encodeURIComponent(assetId)}/content`, {
    credentials: 'same-origin',
    headers: readAccessToken() ? { Authorization: `Bearer ${readAccessToken()}` } : undefined
  })
  if (!response.ok) return ''
  const objectUrl = URL.createObjectURL(await response.blob())
  privateImageCache.set(assetId, objectUrl)
  return objectUrl
}

async function hydratePrivateImages(projectRows: Project[], subscriptionRows: Subscription[], codeRows: ReceivingCode[]) {
  await Promise.all([
    ...codeRows.map(async code => { code.imageUrl = await privateImageUrl(code.imageAssetId) || undefined }),
    ...subscriptionRows.flatMap(subscription => (subscription.paymentImages ?? []).map(async image => {
      image.paymentImageUrl = await privateImageUrl(image.assetId) || undefined
    })),
    ...projectRows.flatMap(project => (project.settlementInvoices ?? []).map(async invoice => {
      invoice.imageUrl = await privateImageUrl(invoice.assetId) || undefined
    }))
  ])
}

function replaceRows<T>(target: T[], rows: T[]) {
  target.splice(0, target.length, ...rows)
}

async function loadData() {
  try {
    const optionalList = <T>(code: string, path: string) => (!limitedAdmin.value || path !== '/api/audit-logs')
      && canApi(authSession.permissionInfo.value, code)
      ? api<{ data: T[] }>(path) : Promise.resolve({ data: [] as T[] })
    const [projectPayload, subscriptionPayload, auditPayload, rulePayload, receivingCodePayload] = await Promise.all([
      optionalList<Project>('crowdfunding:project:query', '/api/projects'),
      optionalList<Subscription>('crowdfunding:subscription:query', '/api/subscriptions'),
      optionalList<AuditRow>('crowdfunding:audit:query', '/api/audit-logs'),
      optionalList<SubscriptionRule>('crowdfunding:rule:query', '/api/rules'),
      optionalList<ReceivingCode>('crowdfunding:receiving-code:query', '/api/receiving-codes')
    ])
    await hydratePrivateImages(projectPayload.data, subscriptionPayload.data, receivingCodePayload.data)
    replaceRows(projects, projectPayload.data)
    replaceRows(subscriptions, subscriptionPayload.data)
    replaceRows(auditRows, auditPayload.data)
    replaceRows(rules, rulePayload.data)
    replaceRows(receivingCodes, receivingCodePayload.data)
  } catch (error) {
    replaceRows(projects, [])
    replaceRows(subscriptions, [])
    replaceRows(auditRows, [])
    replaceRows(rules, [])
    replaceRows(receivingCodes, [])
    ElMessage.warning(error instanceof Error ? `后端数据加载失败：${error.message}` : '后端数据加载失败')
  }
}

function applyRuleFilters() {
  rulePage.value = 1
}

watch(ruleFilters, applyRuleFilters)
watch(activePaymentSubscriptionId, () => {
  reviewActualPaidAmount.value = undefined
  reviewTransactionNo.value = ''
})

function formatMoney(value: number) {
  return `¥ ${value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatDateTime(value?: string) {
  return value || '-'
}

function paymentRemaining(subscription: Subscription) {
  if (['已释放', '缴款逾期'].includes(subscriptionDisplayPay(subscription))) return '-'
  if (subscription.pay !== '未缴款') return '0时0分'
  if (!subscription.paymentDeadlineAt) return '-'
  const remaining = new Date(subscription.paymentDeadlineAt.replace(' ', 'T')).getTime() - Date.now()
  if (remaining <= 0) return '0时0分'
  const totalMinutes = Math.floor(remaining / 60000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return `${hours}时${minutes}分`
}

async function openPayment(subscription: Subscription) {
  if (!await requestAgreement('查看缴款码')) return
  try {
    const payload = await api<{ data: { codeId: string; imageAssetId: string } }>('/api/agreements/confirm-view-code', {
      method: 'POST', body: JSON.stringify({ subscriptionId: subscription.id, agreementVersion: acceptedAgreementVersion.value, agreementsConfirmed: true })
    })
    const code = receivingCodes.find(item => item.id === payload.data.codeId)
    if (code) {
      code.imageAssetId = payload.data.imageAssetId
      code.imageUrl = await privateImageUrl(payload.data.imageAssetId) || undefined
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '缴款码暂不可查看')
    return
  }
  activePaymentSubscriptionId.value = subscription.id
  localPaymentImageUrl.value = ''
  lastOcrResult.value = undefined
  paymentUploadRef.value?.clearFiles()
  go('payment')
}

function handleSubscriptionAction(subscription: Subscription) {
  if (subscriptionDisplayPay(subscription) === '已释放') {
    ElMessage.info('该认购单已因过期未缴款释放，金额已回到项目剩余可认购金额')
    return
  }
  if (subscriptionDisplayPay(subscription) === '缴款逾期') {
    ElMessage.info('缴款期限已过，等待本项目所有认购单到期后统一释放和公司兜底')
    return
  }
  if (subscription.pay === '待确认收款') {
    confirmReceipt(subscription)
    return
  }
  openPayment(subscription)
}

async function confirmReceipt(subscription: Subscription) {
  if (!await requestAgreement('确认收款')) return
  try {
    const payload = await api<{ data: Subscription; message: string }>(`/api/subscriptions/${encodeURIComponent(subscription.id)}/confirm-receipt`, {
      method: 'POST',
      body: JSON.stringify({ agreementVersion: acceptedAgreementVersion.value, agreementsConfirmed: true })
    })
    if (mineFilters.pay === '待确认收款') mineFilters.pay = '已收款'
    await loadData()
    ElMessage.success(payload.message)
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(error instanceof Error ? error.message : '确认收款失败')
  }
}

function projectCostAmount(project: Project) {
  return project.costAmount && project.costAmount >= project.total ? project.costAmount : Math.ceil(project.total * 1.2)
}

function projectSalesAmount(project: Project) {
  const cost = projectCostAmount(project)
  return project.salesAmount && project.salesAmount >= cost ? project.salesAmount : Math.ceil(cost * 1.18)
}

function projectProfitAmount(project: Project) {
  return project.profitAmount ?? projectSalesAmount(project) - projectCostAmount(project)
}

function projectReleasedSubscriptionAmount(project: Project) {
  return subscriptions
    .filter(subscription => isProjectSubscription(project, subscription) && isExpiredUnpaidSubscription(subscription))
    .reduce((sum, subscription) => sum + subscription.amount, 0)
}

function projectEmployeeSubscribedAmount(project: Project) {
  const lockedAmount = project.employeeSubscribedAmount ?? project.subscribed ?? 0
  return Math.max(0, lockedAmount - projectReleasedSubscriptionAmount(project))
}

function projectCompanyTakeoverAmount(project: Project) {
  return Math.max(0, project.companyTakeoverAmount ?? 0)
}

function projectCompanyForcedTakeoverAmount(project: Project) {
  return Math.max(0, project.companyForcedTakeoverAmount ?? 0)
}

function projectCompanyFixedAmount(project: Project) {
  if (project.companyFixedAmount !== undefined) return Math.max(0, project.companyFixedAmount)
  return Math.max(0, projectCostAmount(project) - project.remain - projectEmployeeSubscribedAmount(project) - projectCompanyTakeoverAmount(project) - projectCompanyForcedTakeoverAmount(project))
}

function projectCompanySubscribedAmount(project: Project) {
  return projectCompanyFixedAmount(project) + projectCompanyTakeoverAmount(project) + projectCompanyForcedTakeoverAmount(project)
}

function projectSubscribedAmount(project: Project) {
  return Math.min(projectCostAmount(project), projectCompanySubscribedAmount(project) + projectEmployeeSubscribedAmount(project))
}

function projectRemainAmount(project: Project) {
  return Math.max(0, projectCostAmount(project) - projectSubscribedAmount(project))
}

function projectProgressPercent(project: Project) {
  const cost = projectCostAmount(project)
  return cost > 0 ? Number(((projectSubscribedAmount(project) / cost) * 100).toFixed(1)) : 0
}

function projectOpenRatio(project: Project) {
  const cost = projectCostAmount(project)
  return cost > 0 ? Number(((project.total / cost) * 100).toFixed(1)) : 0
}

function projectUnpaidEmployeeAmount(project: Project) {
  return subscriptions
    .filter(item => (item.projectId === project.id || item.project === project.title) && item.pay === '未缴款')
    .reduce((sum, item) => sum + item.amount, 0)
}

function subscriptionEstimatedProfit(subscription: Subscription) {
  const project = projects.find(item => item.id === subscription.projectId || item.title === subscription.project)
  if (subscription.shares !== undefined) {
    const rule = rules.find(item => item.id === project?.ruleId)
    return estimateShareProfit({
      salesAmount: project?.salesAmount,
      costAmount: project?.costAmount,
      totalShares: rule?.totalShares,
      shares: subscription.shares
    })
  }
  // Legacy amount-based subscriptions have no verified participant allocation yet.
  return null
}

function subscriptionProjectCode(subscription: Subscription) {
  return subscription.projectId ?? projects.find(item => item.title === subscription.project)?.id ?? '-'
}

function reviewPaymentId(subscription: Subscription) {
  if (subscription.id === 'SUB-20260705-0031') return 'PAY-20260705-0092'
  return `PAY-${subscription.id.replace(/^SUB-/, '')}`
}

function go(page: PageKey) {
  if (page !== 'detail' && page !== 'payment' && !authorizedPageKeys.value.has(page as AuthorizedPageKey)) {
    ElMessage.error('暂无访问该页面的权限')
    return
  }
  currentPage.value = page
}

function requireApiPermission(code: string) {
  if (canApi(authSession.permissionInfo.value, code)) return true
  ElMessage.error('暂无执行该操作的权限')
  return false
}

function goProjectDetail(projectId: string) {
  selectedProjectId.value = projectId
  currentPage.value = 'detail'
}

function procurementProjectName(project: Project) {
  return project.title.match(/《([^》]+)》/)?.[1] ?? project.title
}

async function openProcurementOrderDetail() {
  procurementDetailVisible.value = true
  procurementDetailLoading.value = true
  procurementDetailError.value = ''
  procurementOrderDetail.value = undefined
  const params = new URLSearchParams({ projectName: procurementProjectName(selectedProject.value) })
  try {
    const payload = await api<{ data: ProcurementOrderDetail }>(
      `/api/procurement/orders/${encodeURIComponent(selectedProject.value.id)}?${params.toString()}`
    )
    procurementOrderDetail.value = payload.data
  } catch (error) {
    procurementDetailError.value = error instanceof Error ? error.message : '采购订单详情加载失败'
    ElMessage.error(procurementDetailError.value)
  } finally {
    procurementDetailLoading.value = false
  }
}

function projectById(projectId: string) {
  return projects.find(project => project.id === projectId)
}

function isCompanySubscription(subscription: Subscription) {
  return ['company', 'company01', 'superadmin01'].includes(subscription.userId ?? '')
}

function isExpiredUnpaidSubscription(subscription: Subscription) {
  return subscription.shares === undefined && subscription.pay === '未缴款' && getDateTime(subscription.paymentDeadlineAt, Number.POSITIVE_INFINITY) < Date.now()
}

function subscriptionDisplayPay(subscription: Subscription) {
  if (isExpiredUnpaidSubscription(subscription)) return '已释放'
  if (subscription.shares !== undefined && subscription.pay === '未缴款' && getDateTime(subscription.paymentDeadlineAt, Number.POSITIVE_INFINITY) < Date.now()) return '缴款逾期'
  return subscription.pay
}

function subscriptionPayLabel(subscription: Subscription) {
  const pay = subscriptionDisplayPay(subscription)
  if (pay === '待复核') return '已缴款待审核'
  if (pay === '已缴款') return '缴款成功'
  if (pay === '复核驳回') return '缴款被驳回'
  return pay
}

function subscriptionPayTagType(subscription: Subscription) {
  const pay = subscriptionDisplayPay(subscription)
  if (pay === '未缴款') return 'danger'
  if (pay === '待复核') return 'warning'
  if (pay === '复核驳回') return 'danger'
  if (pay === '已释放') return 'info'
  if (pay === '缴款逾期') return 'warning'
  return 'success'
}

function isProjectSubscription(project: Project, subscription: Subscription) {
  return subscription.projectId === project.id || subscription.project === project.title
}

function getAdminProjectEffectiveSubscriptions(project: Project) {
  return subscriptions.filter(subscription => isProjectSubscription(project, subscription) && !isExpiredUnpaidSubscription(subscription))
}

function getAdminProjectParticipantCount(project: Project) {
  const participantKeys = getAdminProjectEffectiveSubscriptions(project)
    .filter(subscription => !isCompanySubscription(subscription))
    .map(subscription => subscription.userId ?? subscription.id)
  return new Set(participantKeys).size
}

function getAdminProjectSubscriptionCount(project: Project) {
  return getAdminProjectEffectiveSubscriptions(project).length
}

function hasRealUserSubscriptions(projectId: string) {
  return subscriptions.some(item => item.projectId === projectId && !isCompanySubscription(item))
}

function getRuleProjectIds(rule: SubscriptionRule) {
  return projects
    .filter(project => project.ruleId === rule.id || project.id === rule.projectId)
    .map(project => project.id)
}

function getProjectSubscriptions(projectId: string) {
  return subscriptions.filter(item => item.projectId === projectId && (!item.userId || item.userId === roleMeta.value.account))
}

function getProjectSubscriptionCount(projectId: string) {
  return getProjectSubscriptions(projectId).length
}

function getProjectSubscriptionStatus(projectId: string) {
  return getProjectSubscriptionCount(projectId) > 0 ? '已认购' : '未认购'
}

function resetProjectFilters() {
  projectFilters.status = '全部'
  projectFilters.subscriptionStatus = '全部'
  projectFilters.subscriptionCount = undefined
  projectFilters.keyword = ''
  projectPage.value = 1
}

function resetMineFilters() {
  mineFilters.keyword = ''
  mineFilters.project = '全部'
  mineFilters.pay = '全部'
  mineFilters.minAmount = undefined
  mineFilters.maxAmount = undefined
}

function openProjectSubscriptions(project: Project) {
  if (getProjectSubscriptionCount(project.id) <= 0) return
  mineFilters.keyword = ''
  mineFilters.project = project.title
  mineFilters.pay = '全部'
  mineFilters.minAmount = undefined
  mineFilters.maxAmount = undefined
  currentPage.value = 'mine'
}

function projectSettlementTagType(project: Project) {
  const status = projectSettlementStatus(project.status)
  if (status === '待结算' || status === '历史待核实') return 'warning'
  if (status === '已中断') return 'danger'
  return 'info'
}

function adminProjectActionLayout(project: Project) {
  return getAdminProjectActionLayout({ status: project.status, remain: projectRemainAmount(project) })
}

async function handleAdminProjectMoreCommand(command: string, project: Project) {
  if (command === 'terminate') {
    await updateProjectLifecycle(project, 'terminate')
    return
  }
  if (command === 'close') { await closeProject(project); return }
  if (command === 'procurementFailure') { await requestProcurementFailure(project); return }
  if (command === 'reopen') { await reopenProject(project); return }
  if (command === 'takeover') await forceTakeover(project)
}

async function closeProject(project: Project) {
  let reason = ''
  try {
    const result = await ElMessageBox.prompt('请填写 5 至 200 字关闭原因', '关闭众筹单', { inputType: 'textarea' })
    reason = result.value.trim()
    if (reason.length < 5 || reason.length > 200) { ElMessage.warning('关闭原因须为 5 至 200 字'); return }
    await ElMessageBox.confirm('关闭后不再接受认购，已缴款员工需逐笔办理并确认退款。确认关闭？',
      '确认关闭', { type: 'warning' })
  } catch { return }
  try {
    const result = await api<{ message: string }>(`/api/projects/${encodeURIComponent(project.id)}/close`, {
      method: 'POST', body: JSON.stringify({ reason }) })
    ElMessage.success(result.message)
    await loadData()
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '发起关闭失败') }
}

async function requestProcurementFailure(project: Project) {
  let reason = ''
  try {
    reason = (await ElMessageBox.prompt('请填写 5 至 200 字采购失败原因', '采购失败终止申请', { inputType: 'textarea' })).value.trim()
    if (reason.length < 5 || reason.length > 200) { ElMessage.warning('终止原因须为 5 至 200 字'); return }
    await ElMessageBox.confirm('公司复核通过后，将按员工已生效缴款足额生成退款事项。确认提交？', '提交公司复核', { type: 'warning' })
  } catch { return }
  try {
    const result = await api<{ message: string }>(`/api/projects/${encodeURIComponent(project.id)}/procurement-failure`, {
      method: 'POST', body: JSON.stringify({ reason }) })
    ElMessage.success(result.message)
    await loadData()
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '提交采购失败申请失败') }
}

async function reopenProject(project: Project) {
  try {
    await ElMessageBox.confirm('系统将创建新草稿并带入原规则。发布前须更新截止时间并核对收款码，确认重开？',
      '重开众筹单', { type: 'warning' })
  } catch { return }
  try {
    const result = await api<{ data: Project; message: string }>(
      `/api/projects/${encodeURIComponent(project.id)}/reopen`, { method: 'POST', body: JSON.stringify({}) })
    ElMessage.success(result.message)
    await loadData()
    selectedProjectId.value = result.data.id
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '重开失败') }
}

function goProjectSettlement(project: Project) {
  selectedProjectId.value = project.id
  currentPage.value = 'settlement'
  settlementInvoiceVisible.value = (project.settledAmount ?? 0) > 0 && (project.settledAmount ?? 0) < projectSalesAmount(project)
  invoiceOcrState.value = 'none'
  invoiceImageUrl.value = ''
  invoiceImageName.value = ''
  invoiceOcrResult.value = undefined
  invoiceOcrError.value = ''
  invoiceSettlementKey.value = ''
  ElMessage.success(`已进入发票凭证核对：${project.title}`)
}

function openPayReviewFromProject(project: Project) {
  selectedProjectId.value = project.id
  activePaymentSubscriptionId.value = paymentReviewSubscriptions.value.find(subscription => isProjectSubscription(project, subscription))?.id ?? ''
  currentPage.value = 'payReview'
  ElMessage.success(`已进入支付复核：${project.title}`)
}

function backToAdminProjects() {
  currentPage.value = 'adminProjects'
}

function resetReceivingCodeFilters() {
  receivingCodeFilters.keyword = ''
  receivingCodeFilters.status = '全部'
}

function isRuleLocked(rule: SubscriptionRule) {
  return getRuleProjectIds(rule).some(projectId => subscriptions.some(item => item.projectId === projectId))
}

function isReceivingCodeImageLocked(receivingCodeId: string) {
  const linkedProjects = new Set(rules.filter(rule => rule.receivingCodeId === receivingCodeId).map(rule => rule.projectId))
  return subscriptions.some(item => linkedProjects.has(item.projectId ?? ''))
}

function fillRuleForm(rule: SubscriptionRule) {
  ruleForm.projectId = rule.projectId
  ruleForm.ruleName = rule.ruleName
  ruleForm.totalAmount = rule.totalAmount
  ruleForm.sharePrice = rule.sharePrice
  ruleForm.companyFrontShares = rule.companyFrontShares
  ruleForm.maxSharesPerEmployee = rule.maxSharesPerEmployee
  ruleForm.companyFixedAmount = rule.companyFixedAmount
  ruleForm.minAmount = rule.minAmount
  ruleForm.minParticipants = rule.minParticipants
  ruleForm.receivingCodeId = rule.receivingCodeId ?? enabledReceivingCodes.value[0]?.id ?? ''
  ruleForm.allowMultiple = rule.allowMultiple
  ruleForm.companyTakeover = rule.companyTakeover
  ruleForm.status = rule.status
  ruleForm.startAt = rule.startAt
  ruleForm.endAt = rule.endAt
  ruleForm.paymentCutoffAt = rule.paymentCutoffAt ?? ''
  ruleForm.plannedPaymentDate = rule.plannedPaymentDate ?? ''
}

function resetRuleForm(project?: Project) {
  Object.assign(ruleForm, createEmptyRuleForm())
  ruleForm.receivingCodeId = enabledReceivingCodes.value[0]?.id ?? ''
  if (project) {
    ruleForm.projectId = project.id
    ruleForm.companyFixedAmount = projectCompanyFixedAmount(project)
    ruleForm.minParticipants = 1
    ruleForm.receivingCodeId = enabledReceivingCodes.value[0]?.id ?? ''
    ruleForm.companyTakeover = true
    ruleForm.endAt = project.deadline
  }
}

function openRuleCreate(projectId?: string) {
  const project = projectId ? projects.find(item => item.id === projectId) : undefined
  const existingRule = project
    ? rules.find(item => item.projectId === project.id && item.status === '已启用')
      ?? rules.find(item => item.projectId === project.id && item.status !== '已停用')
      ?? rules.find(item => item.projectId === project.id)
    : undefined
  const locked = Boolean(projectId && project && hasRealUserSubscriptions(project.id))
  ruleReadonly.value = locked
  if (locked) {
    ElMessage.warning('该项目已开放认购且已有真实用户认购记录，不支持修改规则配置内容')
  }
  editingRuleId.value = !locked && existingRule ? existingRule.id : ''
  if (existingRule) {
    fillRuleForm(existingRule)
  } else {
    resetRuleForm(project)
  }
  ruleCreateVisible.value = true
}

function openRuleDetail(projectId: string) {
  const project = projects.find(item => item.id === projectId) ?? projects[0]
  const existingRule = project
    ? rules.find(item => item.id === project.ruleId)
      ?? rules.find(item => item.projectId === project.id && item.status === '已启用')
      ?? rules.find(item => item.projectId === project.id && item.status !== '已停用')
      ?? rules.find(item => item.projectId === project.id)
    : undefined
  ruleReadonly.value = true
  editingRuleId.value = ''
  if (existingRule) {
    fillRuleForm(existingRule)
  } else {
    Object.assign(ruleForm, createEmptyRuleForm())
    ruleForm.projectId = project?.id ?? 'PRJ-20260701-003'
    ruleForm.ruleName = '暂无已配置规则'
    ruleForm.totalAmount = project?.total ?? 0
    ruleForm.minAmount = 100
    ruleForm.minParticipants = 1
    ruleForm.receivingCodeId = enabledReceivingCodes.value[0]?.id ?? ''
    ruleForm.allowMultiple = false
    ruleForm.companyTakeover = false
    ruleForm.status = '未启用'
    ruleForm.startAt = ''
    ruleForm.endAt = project?.deadline ?? ''
  }
  ruleCreateVisible.value = true
}

function canViewProjectRule(project: Project) {
  return project.status !== '未开放' || Boolean(project.ruleId)
}

function openRuleEdit(rule: SubscriptionRule) {
  const locked = isRuleLocked(rule)
  ruleReadonly.value = locked
  editingRuleId.value = locked ? '' : rule.id
  if (locked) {
    ElMessage.warning('该规则已被有真实认购记录的项目使用，不支持修改规则配置内容')
  }
  fillRuleForm(rule)
  ruleCreateVisible.value = true
}

async function updateProjectLifecycle(project: Project, action: 'open' | 'terminate') {
  const isOpenAction = action === 'open'
  if (isOpenAction) {
    openProjectRuleDialog(project)
    return
  }
  const title = isOpenAction ? '开放项目认购' : '停止未开放项目'
  const message = isOpenAction
    ? `确认开放「${project.title}」？开放后员工端可查看并发起认购。`
    : `确认停止尚未开放的「${project.title}」？`
  const confirmButtonText = isOpenAction ? '确认开放' : '确认停止'
  try {
    await ElMessageBox.confirm(message, title, {
      confirmButtonText,
      cancelButtonText: '取消',
      type: isOpenAction ? 'warning' : 'error'
    })
    const payload = await api<{ data: Project; message: string }>(`/api/projects/${project.id}/${action}`, {
      method: 'POST',
      body: JSON.stringify({ operator: `${roleMeta.value.account} · ${roleMeta.value.label}` })
    })
    await loadData()
    ElMessage.success(payload.message)
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(error instanceof Error ? error.message : `${title}失败`)
  }
}

function openProjectRuleDialog(project: Project) {
  openProjectId.value = project.id
  openProjectTitle.value = project.title
  selectedOpenRuleId.value =
    openRuleOptions.value.find(rule => rule.id === project.ruleId && rule.projectId === project.id)?.id
    ?? openRuleOptions.value.find(rule => rule.projectId === project.id)?.id
    ?? ''
  if (!selectedOpenRuleId.value) {
    ElMessage.warning('请先创建并启用当前项目归属的认购规则后再开放项目')
    return
  }
  openProjectVisible.value = true
}

async function submitOpenProject() {
  if (!selectedOpenRuleId.value) {
    ElMessage.warning('请选择认购规则配置')
    return
  }
  try {
    const payload = await api<{ data: Project; message: string }>(`/api/projects/${openProjectId.value}/open`, {
      method: 'POST',
      body: JSON.stringify({
        operator: `${roleMeta.value.account} · ${roleMeta.value.label}`,
        ruleId: selectedOpenRuleId.value
      })
    })
    openProjectVisible.value = false
    await loadData()
    ElMessage.success(payload.message)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '开放项目认购失败')
  }
}

function openInterrupt(projectId: string) {
  const project = projectById(projectId)
  if (!project) return
  interruptProjectId.value = project.id
  interruptProjectTitle.value = project.title
  interruptReason.value = ''
  interruptVisible.value = true
}

async function submitInterrupt() {
  try {
    const payload = await api<{ data: Project; message: string }>(`/api/projects/${interruptProjectId.value}/interrupt`, {
      method: 'POST',
      body: JSON.stringify({ reason: interruptReason.value, operator: `${roleMeta.value.account} · ${roleMeta.value.label}` })
    })
    interruptVisible.value = false
    await loadData()
    ElMessage.success(payload.message)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '中断认购失败')
  }
}

async function submitRule() {
  if (ruleReadonly.value) {
    ElMessage.warning('该规则已被有真实认购记录的项目使用，规则配置只读不可保存')
    return
  }
  if (ruleFormLockedBySubscriptions.value) {
    ElMessage.warning('该规则已被有真实认购记录的项目使用，不支持修改规则配置内容')
    return
  }
  if (!ruleForm.receivingCodeId || !selectedRuleReceivingCode.value) {
    ElMessage.warning('请选择当前启用的项目收款码')
    return
  }
  let shareRule: ReturnType<typeof prepareShareRule> | undefined
  if (isShareRuleForm.value) {
    try {
      if (!selectedRuleProject.value) throw new RangeError('请选择采购项目')
      shareRule = prepareShareRule(projectCostAmount(selectedRuleProject.value), Number(ruleForm.sharePrice),
        Number(ruleForm.companyFrontShares), ruleForm.maxSharesPerEmployee)
      validatePublishSchedule({ subscriptionCutoffAt: ruleForm.endAt, paymentCutoffAt: ruleForm.paymentCutoffAt,
        plannedPaymentDate: ruleForm.plannedPaymentDate })
    } catch (error) {
      ElMessage.warning(error instanceof Error ? error.message : '份额规则无效')
      return
    }
  }
  const totalAmount = shareRule?.totalAmount ?? derivedRuleTotalAmount.value
  const companyFixedAmount = shareRule?.companyFixedAmount ?? Number(ruleForm.companyFixedAmount ?? 0)
  const projectCost = selectedRuleProject.value ? projectCostAmount(selectedRuleProject.value) : 0
  if (!Number.isFinite(totalAmount) || !Number.isFinite(companyFixedAmount) || companyFixedAmount < 0 || companyFixedAmount >= projectCost) {
    ElMessage.warning('公司固定认购金额必须小于项目成本金额')
    return
  }
  if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
    ElMessage.warning('开放认购金额必须大于 0 元')
    return
  }
  const minAmount = shareRule?.sharePrice ?? derivedRuleMinAmount.value
  if (!Number.isFinite(minAmount) || minAmount > totalAmount) {
    ElMessage.warning('单次认购最低金额不可高于开放认购金额')
    return
  }
  const submitRuleForm = {
    ...ruleForm,
    ...shareRule,
    companyFixedAmount,
    totalAmount,
    minAmount
  }
  try {
    const wasEditing = Boolean(editingRuleId.value)
    const endpoint = wasEditing ? `/api/rules/${editingRuleId.value}/update` : '/api/rules'
    await api<{ data: SubscriptionRule }>(endpoint, {
      method: 'POST',
      body: JSON.stringify({ ...submitRuleForm, operator: `${roleMeta.value.account} · ${roleMeta.value.label}` })
    })
    ruleCreateVisible.value = false
    editingRuleId.value = ''
    await loadData()
    ElMessage.success(wasEditing ? '认购规则已修改' : '认购规则已创建')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '认购规则保存失败')
  }
}

async function updateRuleStatus(rule: SubscriptionRule, status: '已启用' | '已停用') {
  if (status === '已启用' && rule.status !== '未启用') {
    ElMessage.warning('仅未启用状态的认购规则支持启用')
    return
  }
  if (status === '已停用' && rule.status !== '已启用') {
    ElMessage.warning('仅已启用状态的认购规则支持停用')
    return
  }
  if (status === '已停用' && isRuleLocked(rule)) {
    ElMessage.warning('该规则已被有真实认购记录的项目使用，不支持停用')
    return
  }
  try {
    const actionText = status === '已启用' ? '启用' : '停用'
    await ElMessageBox.confirm(`确认${actionText}认购规则「${rule.ruleName}」？`, `${actionText}认购规则`, {
      confirmButtonText: `确认${actionText}`,
      cancelButtonText: '取消',
      type: 'warning'
    })
    const payload = await api<{ data: SubscriptionRule; message: string }>(`/api/rules/${rule.id}/status`, {
      method: 'POST',
      body: JSON.stringify({ status, operator: `${roleMeta.value.account} · ${roleMeta.value.label}` })
    })
    await loadData()
    ElMessage.success(payload.message)
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(error instanceof Error ? error.message : '认购规则状态更新失败')
  }
}

async function deleteRule(rule: SubscriptionRule) {
  if (isRuleLocked(rule)) {
    ElMessage.warning('该规则已被有真实认购记录的项目使用，不支持删除')
    return
  }
  try {
    await ElMessageBox.confirm(`确认删除认购规则「${rule.ruleName}」？删除后不可恢复。`, '删除认购规则', {
      confirmButtonText: '确认删除',
      cancelButtonText: '取消',
      type: 'warning'
    })
    const payload = await api<{ message: string }>(`/api/rules/${rule.id}/delete`, {
      method: 'POST',
      body: JSON.stringify({ operator: `${roleMeta.value.account} · ${roleMeta.value.label}` })
    })
    await loadData()
    ElMessage.success(payload.message)
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(error instanceof Error ? error.message : '认购规则删除失败')
  }
}

function openReceivingCodeCreate() {
  receivingCodeForm.subject = 'XX 科技有限公司'
  receivingCodeForm.accountNote = '支付宝收款码 · 财务专用'
  receivingCodeForm.codeName = '支付宝收款码'
  receivingCodeImageUrl.value = ''
  receivingCodeImageName.value = ''
  receivingCodeImageFile.value = undefined
  receivingCodeCreateRequestId.value = crypto.randomUUID()
  receivingCodeSubmitting.value = false
  receivingCodeUploadRef.value?.clearFiles()
  receivingCodeCreateVisible.value = true
}

function handleReceivingCodeImageChange(file: UploadFile) {
  if (!file.raw || !['image/png', 'image/jpeg', 'image/webp'].includes(file.raw.type) || file.raw.size > 5 * 1024 * 1024) {
    receivingCodeUploadRef.value?.clearFiles()
    ElMessage.error('收款码图片仅支持 PNG、JPG 或 WebP，且大小不能超过 5MB')
    return
  }
  receivingCodeImageName.value = file.raw.name
  receivingCodeImageFile.value = file.raw
  const reader = new FileReader()
  reader.onload = () => {
    receivingCodeImageUrl.value = typeof reader.result === 'string' ? reader.result : ''
  }
  reader.onerror = () => ElMessage.error('收款码图片读取失败，请重新选择')
  reader.readAsDataURL(file.raw)
}

function removeReceivingCodeImage() {
  receivingCodeImageUrl.value = ''
  receivingCodeImageName.value = ''
  receivingCodeImageFile.value = undefined
  receivingCodeUploadRef.value?.clearFiles()
}

function currentDateTimeText() {
  return new Date().toLocaleString('sv-SE').replace('T', ' ')
}

async function createReceivingCode() {
  if (receivingCodeSubmitting.value) return
  if (!receivingCodeForm.subject.trim() || !receivingCodeForm.accountNote.trim() || !receivingCodeForm.codeName.trim()) {
    ElMessage.error('请完整填写收款主体、账户说明和收款码名称')
    return
  }
  receivingCodeSubmitting.value = true
  try {
    let body: FormData | string
    if (receivingCodeImageFile.value) {
      const form = new FormData()
      form.set('subject', receivingCodeForm.subject.trim())
      form.set('accountNote', receivingCodeForm.accountNote.trim())
      form.set('codeName', receivingCodeForm.codeName.trim())
      form.set('operator', `${roleMeta.value.account} · ${roleMeta.value.label}`)
      form.set('createRequestId', receivingCodeCreateRequestId.value)
      form.set('image', receivingCodeImageFile.value, receivingCodeImageFile.value.name)
      body = form
    } else {
      body = JSON.stringify({
        subject: receivingCodeForm.subject.trim(),
        accountNote: receivingCodeForm.accountNote.trim(),
        codeName: receivingCodeForm.codeName.trim(),
        operator: `${roleMeta.value.account} · ${roleMeta.value.label}`,
        createRequestId: receivingCodeCreateRequestId.value
      })
    }
    const payload = await api<{ data: ReceivingCode; message: string }>('/api/receiving-codes', { method: 'POST', body })
    await loadData()
    receivingCodeCreateVisible.value = false
    ElMessage.success(payload.message)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '收款码创建失败')
  } finally {
    receivingCodeSubmitting.value = false
  }
}

function openReceivingCodeImage(row: ReceivingCode) {
  editingReceivingCodeId.value = row.id
  editingReceivingCodeImageUrl.value = ''
  editingReceivingCodeImageName.value = ''
  editingReceivingCodeImageFile.value = undefined
  receivingCodeImageUploadRef.value?.clearFiles()
  receivingCodeImageVisible.value = true
}

function handleExistingReceivingCodeImageChange(file: UploadFile) {
  if (!file.raw || !['image/png', 'image/jpeg', 'image/webp'].includes(file.raw.type) || file.raw.size > 5 * 1024 * 1024) {
    receivingCodeImageUploadRef.value?.clearFiles()
    ElMessage.error('收款码图片仅支持 PNG、JPG 或 WebP，且大小不能超过 5MB')
    return
  }
  editingReceivingCodeImageName.value = file.raw.name
  editingReceivingCodeImageFile.value = file.raw
  const reader = new FileReader()
  reader.onload = () => {
    editingReceivingCodeImageUrl.value = typeof reader.result === 'string' ? reader.result : ''
  }
  reader.onerror = () => ElMessage.error('收款码图片读取失败，请重新选择')
  reader.readAsDataURL(file.raw)
}

async function saveReceivingCodeImage() {
  if (!editingReceivingCodeId.value || !editingReceivingCodeImageFile.value) {
    ElMessage.warning('请先选择真实收款码图片')
    return
  }
  try {
    const form = new FormData()
    form.set('operator', `${roleMeta.value.account} · ${roleMeta.value.label}`)
    form.set('image', editingReceivingCodeImageFile.value, editingReceivingCodeImageFile.value.name)
    const payload = await api<{ data: ReceivingCode; message: string }>(`/api/receiving-codes/${editingReceivingCodeId.value}/image`, { method: 'POST', body: form })
    await loadData()
    receivingCodeImageVisible.value = false
    ElMessage.success(payload.message)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '收款码图片保存失败')
  }
}

async function disableReceivingCode(row: ReceivingCode) {
  try {
    const reason = await ElMessageBox.prompt('禁用后管理层不可在新开放项目中选择该收款码，请填写禁用理由。', '禁用收款码', {
      confirmButtonText: '确认禁用',
      cancelButtonText: '取消',
      inputType: 'textarea',
      inputPlaceholder: '请输入禁用理由',
      inputValidator: value => Boolean(value?.trim()) || '禁用理由必填',
      type: 'warning'
    })
    const payload = await api<{ data: ReceivingCode; message: string }>(`/api/receiving-codes/${row.id}/disable`, {
      method: 'POST',
      body: JSON.stringify({ reason: reason.value.trim(), operator: `${roleMeta.value.account} · ${roleMeta.value.label}` })
    })
    await loadData()
    ElMessage.success(payload.message)
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error('收款码禁用失败')
  }
}

async function startSubscribe() {
  if (!canSubscribe.value) {
    ElMessage.error(selectedProjectShareRule.value ? '认购份数需为正整数，且不能超过剩余份数或个人上限' : '认购金额需不低于 100 元，且不得超过剩余可认购金额')
    return
  }
  if (!await requestAgreement('提交认购')) return
  subscribeVisible.value = true
}

async function requestAgreement(node: '提交认购' | '查看缴款码' | '确认收款') {
  try {
    const payload = await api<{ data: AgreementVersion | null }>('/api/agreements/current')
    if (!payload.data) { ElMessage.error('协议尚未配置，请联系公司'); return false }
    currentAgreement.value = payload.data
    agreementNode.value = node
    acceptedAgreementVersion.value = undefined
    agreementReadToEnd.value = false
    agreementVisible.value = true
    await nextTick()
    const element = agreementBodyElement.value
    if (element && element.scrollHeight <= element.clientHeight + 2) agreementReadToEnd.value = true
    return await new Promise<boolean>(resolve => { agreementResolver = resolve })
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '协议加载失败')
    return false
  }
}

function onAgreementScroll(event: Event) {
  const element = event.target as HTMLElement
  if (element.scrollTop + element.clientHeight >= element.scrollHeight - 3) agreementReadToEnd.value = true
}

function onAgreementOpened() {
  const element = agreementBodyElement.value
  if (element && element.scrollHeight <= element.clientHeight + 2) agreementReadToEnd.value = true
}

function finishAgreement(accepted: boolean) {
  if (accepted && !agreementReadToEnd.value) return
  if (accepted) acceptedAgreementVersion.value = currentAgreement.value?.version
  const resolve = agreementResolver
  agreementResolver = undefined
  agreementVisible.value = false
  resolve?.(accepted)
  if (!accepted) ElMessage.info('需确认免责协议后方可继续')
}

watch(agreementVisible, visible => { if (!visible && agreementResolver) finishAgreement(false) })

async function loadAgreementVersions() {
  const payload = await api<{ data: { items: AgreementVersion[]; total: number } }>(`/api/agreements?page=${agreementVersionPage.value}&pageSize=10`)
  agreementVersions.value = payload.data.items
  agreementVersionTotal.value = payload.data.total
}

async function createAgreementVersion() {
  try {
    await ElMessageBox.confirm('新版本提交后立即生效且不可修改，确认提交？', '新增免责协议版本', { type: 'warning' })
    await api('/api/agreements', { method: 'POST', body: JSON.stringify(agreementForm) })
    agreementFormVisible.value = false
    agreementForm.title = ''
    agreementForm.body = ''
    agreementVersionPage.value = 1
    await loadAgreementVersions()
    ElMessage.success('新版本已生效')
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(error instanceof Error ? error.message : '协议保存失败')
  }
}

async function showAgreementConfirmations(version: number) {
  agreementConfirmationVersion.value = version
  agreementConfirmationPage.value = 1
  agreementConfirmationFilters.userId = ''
  agreementConfirmationFilters.node = ''
  agreementConfirmationFilters.dates = []
  await loadAgreementConfirmations()
}

async function loadAgreementConfirmations() {
  const version = agreementConfirmationVersion.value
  if (version === undefined) return
  try {
    const params = new URLSearchParams({ page: String(agreementConfirmationPage.value), pageSize: '10' })
    if (agreementConfirmationFilters.userId.trim()) params.set('userId', agreementConfirmationFilters.userId.trim())
    if (agreementConfirmationFilters.node) params.set('node', agreementConfirmationFilters.node)
    if (agreementConfirmationFilters.dates.length === 2) {
      params.set('from', `${agreementConfirmationFilters.dates[0]}T00:00:00.000Z`)
      params.set('to', `${agreementConfirmationFilters.dates[1]}T23:59:59.999Z`)
    }
    const payload = await api<{ data: { items: AgreementConfirmation[]; total: number } }>(`/api/agreements/${version}/confirmations?${params}`)
    agreementConfirmations.value = payload.data.items
    agreementConfirmationTotal.value = payload.data.total
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : '确认记录加载失败') }
}

watch(agreementVersionPage, () => { if (currentPage.value === 'agreements') void loadAgreementVersions() })
watch(currentPage, page => { if (page === 'agreements') void loadAgreementVersions() })
watch(agreementConfirmationPage, () => { void loadAgreementConfirmations() })

async function confirmSubscribe() {
  const amount = effectiveSubscribeAmount.value
  try {
    await api<{ data: Subscription }>('/api/subscriptions', {
      method: 'POST',
      body: JSON.stringify({
        projectId: selectedProject.value.id,
        userId: roleMeta.value.account,
        amount,
        ...(selectedProjectShareRule.value ? { shares: subscribeShares.value } : {}),
        agreementsConfirmed: true,
        agreementVersion: acceptedAgreementVersion.value,
        idempotencyKey: `ui-${Date.now()}-${Math.random().toString(16).slice(2)}`
      })
    })
    await loadData()
    subscribeVisible.value = false
    currentPage.value = 'mine'
    ElMessage.success('认购已提交，额度已锁定')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '认购提交失败')
  }
}

async function submitPaymentImage(paymentImage: File) {
  ocrState.value = 'loading'
  try {
    const form = new FormData()
    form.set('paymentId', 'PAY-20260705-0092')
    form.set('subscriptionId', activePaymentSubscription.value?.id ?? '')
    form.set('expectedAmount', String(activePaymentAmount.value))
    form.set('operator', `${roleMeta.value.account} · ${roleMeta.value.label}`)
    form.set('image', paymentImage, paymentImage.name)
    const payload = await api<{ data: { status: string; ocr_status: string; recognized_total: number; remaining_amount: number; image_count: number; reason?: string } }>('/api/payments/ocr', { method: 'POST', body: form })
    await loadData()
    lastOcrResult.value = {
      recognizedTotal: payload.data.recognized_total,
      remainingAmount: payload.data.remaining_amount,
      imageCount: payload.data.image_count
    }
    ocrState.value = payload.data.ocr_status === '待财务复核'
      ? 'fail'
      : payload.data.recognized_total === activePaymentAmount.value
        ? 'ok'
        : 'mismatch'
    if (payload.data.ocr_status === '待财务复核') {
      ElMessage.warning('未识别到有效交易金额，截图已保存并转入财务复核')
    } else {
      ElMessage.success(payload.data.remaining_amount === 0 ? '累计识别金额已匹配认购金额' : `本次截图已保存，仍需识别 ${formatMoney(payload.data.remaining_amount)}`)
    }
  } catch (error) {
    ocrState.value = 'fail'
    localPaymentImageUrl.value = activePaymentSubscription.value?.paymentImageUrl || ''
    ElMessage.error(error instanceof Error ? error.message : 'OCR 校验失败')
  }
}

async function deleteFailedPaymentImage(image: PaymentImage) {
  if (image.status !== '识别失败' || !activePaymentSubscription.value) return
  try {
    await ElMessageBox.confirm(`确认删除识别失败的截图「${image.paymentImageName}」？`, '删除支付截图', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning'
    })
    await api('/api/payments/images/delete', {
      method: 'POST',
      body: JSON.stringify({
        subscriptionId: activePaymentSubscription.value.id,
        imageId: image.id,
        operator: `${roleMeta.value.account} · ${roleMeta.value.label}`
      })
    })
    await loadData()
    localPaymentImageUrl.value = ''
    lastOcrResult.value = undefined
    ocrState.value = activePaymentImages.value.some(item => item.status === '识别失败')
      ? 'fail'
      : activePaymentImages.value.length === 0
        ? 'none'
        : activePaymentRecognizedAmount.value >= activePaymentAmount.value
          ? 'ok'
          : 'mismatch'
    ElMessage.success('识别失败的支付截图已删除')
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(error instanceof Error ? error.message : '删除支付截图失败')
  }
}

async function handlePaymentImageChange(file: UploadFile) {
  const raw = file.raw
  const supportedTypes = new Set(['image/png', 'image/jpeg', 'image/bmp'])
  if (!raw || !supportedTypes.has(raw.type)) {
    paymentUploadRef.value?.clearFiles()
    ElMessage.warning('支付截图仅支持 PNG、JPG 或 BMP 图片')
    return
  }
  if (raw.size > 5 * 1024 * 1024) {
    paymentUploadRef.value?.clearFiles()
    ElMessage.warning('支付截图大小不能超过 5MB')
    return
  }

  const reader = new FileReader()
  reader.onerror = () => {
    paymentUploadRef.value?.clearFiles()
    ElMessage.error('支付截图读取失败，请重新选择')
  }
  reader.onload = async () => {
    if (typeof reader.result !== 'string') return
    localPaymentImageUrl.value = reader.result
    paymentUploadRef.value?.clearFiles()
    await submitPaymentImage(raw)
  }
  reader.readAsDataURL(raw)
}

async function discardPendingInvoice(result: InvoiceOcrResult, projectId: string) {
  if (!result.assetId || !result.settlementProofId) return ''
  const payload = await api<{ message: string }>('/api/invoices/pending/delete', {
    method: 'POST',
    body: JSON.stringify({ projectId, assetId: result.assetId, settlementProofId: result.settlementProofId })
  })
  return payload.message
}

async function runInvoiceOcr(file: UploadFile) {
  const raw = file.raw
  if (!raw) return
  const requestId = invoiceOcrRequestId.value + 1
  invoiceOcrRequestId.value = requestId
  const projectId = selectedProject.value.id
  const previousResult = invoiceOcrResult.value
  if (previousResult?.assetId) {
    invoiceDeleting.value = true
    try {
      await discardPendingInvoice(previousResult, projectId)
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : '旧发票文件清理失败，未开始重新上传')
      return
    } finally {
      invoiceDeleting.value = false
    }
    if (requestId !== invoiceOcrRequestId.value) return
  }
  const validationError = validateInvoiceImage(raw)
  if (validationError) {
    invoiceOcrState.value = 'fail'
    invoiceImageUrl.value = ''
    invoiceImageName.value = ''
    invoiceOcrResult.value = undefined
    invoiceOcrError.value = validationError
    ElMessage.warning(validationError)
    return
  }

  invoiceOcrState.value = 'loading'
  invoiceOcrResult.value = undefined
  invoiceOcrError.value = ''
  const reader = new FileReader()
  reader.onerror = () => {
    if (requestId !== invoiceOcrRequestId.value) return
    invoiceOcrState.value = 'fail'
    invoiceOcrError.value = '发票图片读取失败，请重新选择'
    ElMessage.error('发票图片读取失败，请重新选择')
  }
  reader.onload = async () => {
    if (requestId !== invoiceOcrRequestId.value) return
    if (typeof reader.result !== 'string') {
      invoiceOcrState.value = 'fail'
      invoiceOcrError.value = '发票图片读取失败，请重新选择'
      return
    }
    invoiceImageUrl.value = reader.result
    invoiceImageName.value = raw.name
    invoiceImageFile.value = raw
    try {
      const form = new FormData()
      form.set('projectId', projectId)
      form.set('fileName', raw.name)
      form.set('operator', `${roleMeta.value.account} · ${roleMeta.value.label}`)
      form.set('image', raw, raw.name)
      const payload = await api<{ data: InvoiceOcrResult; message: string }>('/api/invoices/ocr', { method: 'POST', body: form })
      if (requestId !== invoiceOcrRequestId.value) {
        try { await discardPendingInvoice(payload.data, projectId) }
        catch { ElMessage.warning('已取消的发票文件清理失败，请联系管理员检查待确认文件') }
        return
      }
      invoiceOcrResult.value = payload.data
      invoiceSettlementKey.value = `SETTLEMENT-${selectedProject.value.id}-${Date.now()}`
      invoiceOcrState.value = 'ok'
      ElMessage.success(payload.data.amount === undefined ? '发票 OCR 识别完成' : '发票 OCR 识别完成，金额已识别')
    } catch (error) {
      if (requestId !== invoiceOcrRequestId.value) return
      invoiceOcrState.value = 'fail'
      invoiceOcrError.value = error instanceof Error ? error.message : '发票 OCR 识别失败'
      ElMessage.error(invoiceOcrError.value)
    }
  }
  reader.readAsDataURL(raw)
}

function invoiceFieldValue(key: string) {
  return invoiceOcrResult.value?.fields.find(field => field.key === key)?.value ?? '未识别'
}

function resetInvoiceRecognition() {
  invoiceOcrState.value = 'none'
  invoiceImageUrl.value = ''
  invoiceImageName.value = ''
  invoiceImageFile.value = undefined
  invoiceOcrResult.value = undefined
  invoiceOcrError.value = ''
  invoiceSettlementKey.value = ''
}

function openInvoicePreview() {
  if (!invoiceImageUrl.value) return
  invoicePreviewVisible.value = true
}

async function removePendingInvoice() {
  if (invoiceDeleting.value || settlementSubmitting.value) return
  invoiceOcrRequestId.value += 1
  const result = invoiceOcrResult.value
  const projectId = selectedProject.value.id
  invoiceDeleting.value = true
  try {
    const message = result ? await discardPendingInvoice(result, projectId) : ''
    invoicePreviewVisible.value = false
    resetInvoiceRecognition()
    ElMessage.success(message || '已清除当前待确认发票')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '待确认发票删除失败')
  } finally {
    invoiceDeleting.value = false
  }
}

async function confirmSettlementInvoice() {
  if (invoiceDeleting.value) return
  if (!currentInvoiceCanConfirm.value || currentInvoiceAmount.value === undefined || !invoiceOcrResult.value?.settlementProofId || !invoiceOcrResult.value.assetId) {
    ElMessage.warning(currentInvoiceExceedsRemaining.value ? '交易金额超过项目剩余待结算金额' : '当前识别结果没有可确认的交易金额')
    return
  }
  settlementSubmitting.value = true
  try {
    const payload = await api<{
      data: { project: Project; settledAmount: number; remainingAmount: number; canUploadMore: boolean }
      message: string
    }>(`/api/projects/${encodeURIComponent(selectedProject.value.id)}/settlements/confirm`, {
      method: 'POST',
      body: JSON.stringify({
        idempotencyKey: invoiceSettlementKey.value,
        settlementProofId: invoiceOcrResult.value.settlementProofId,
        assetId: invoiceOcrResult.value.assetId,
        operator: `${roleMeta.value.account} · ${roleMeta.value.label}`
      })
    })
    await loadData()
    settlementInvoiceVisible.value = payload.data.canUploadMore
    resetInvoiceRecognition()
    ElMessage.success(payload.message)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '确认发票凭证失败')
  } finally {
    settlementSubmitting.value = false
  }
}

async function syncMcp() {
  ElMessageBox.confirm('将从 MCP 适配层同步可认购项目，失败不会覆盖已有有效项目。确认执行？', '同步采购系统（MCP）', {
    confirmButtonText: '确认同步',
    cancelButtonText: '取消',
    type: 'warning'
  }).then(async () => {
    const payload = await api<{ message: string }>('/api/mcp/sync', { method: 'POST', body: JSON.stringify({}) })
    await loadData()
    ElMessage.success(payload.message)
  })
}

async function startSettlement() {
  try {
    settlementInvoiceVisible.value = await beginSettlement(() => ElMessageBox.confirm(
      '确认开始核对发票凭证？发票金额不能作为客户回款或分润完成的依据。',
      '核对发票凭证',
      {
        confirmButtonText: '开始核对',
        cancelButtonText: '取消',
        type: 'warning'
      }
    ))
    ElMessage.success('请上传项目发票进行凭证核对')
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(error instanceof Error ? error.message : '开始核对失败')
  }
}

async function submitPaymentReview(result: 'pass' | 'reject' | 'partial') {
  if (!requireApiPermission(reviewPermissionFor(result))) return
  const subscription = activeReviewSubscription.value
  if (!subscription || subscriptionDisplayPay(subscription) !== '待复核') {
    ElMessage.warning('当前没有待复核记录')
    return
  }
  if (subscription.shares !== undefined && result === 'pass' && (!reviewActualPaidAmount.value || !reviewTransactionNo.value.trim())) {
    ElMessage.warning('请填写实际到账金额和交易流水号后再复核')
    return
  }
  const config = {
    pass: { title: '复核通过', message: '确认该笔支付有效？确认后员工缴款状态将更新为“缴款成功”。' },
    reject: { title: '复核驳回', message: '确认驳回该笔支付？确认后员工缴款状态将更新为“缴款被驳回”，并需重新上传支付截图。' },
    partial: { title: '标记部分缴款', message: '确认后将生成待补款提示。' }
  }[result]
  try {
    let rejectReason = ''
    if (result === 'reject') {
      const promptResult = await ElMessageBox.prompt(config.message, config.title, {
        confirmButtonText: '确认驳回',
        cancelButtonText: '取消',
        inputPlaceholder: '请填写驳回理由',
        inputType: 'textarea',
        inputValue: '支付截图信息不完整，请重新上传包含金额、收款方与交易流水的支付成功截图。',
        inputValidator: value => Boolean(value?.trim()) || '请填写驳回理由'
      })
      rejectReason = promptResult.value.trim()
    } else {
      await ElMessageBox.confirm(config.message, config.title, {
        confirmButtonText: '确认执行',
        cancelButtonText: '取消',
        type: 'warning'
      })
    }
    const payload = await api<{ data: Subscription; message: string }>(`/api/subscriptions/${subscription.id}/review`, {
      method: 'POST',
      body: JSON.stringify({
        result,
        rejectReason,
        ...(subscription.shares !== undefined && result === 'pass'
          ? { actualPaidAmount: reviewActualPaidAmount.value, transactionNo: reviewTransactionNo.value.trim() }
          : {}),
        operator: `${roleMeta.value.account} · ${roleMeta.value.label}`
      })
    })
    await loadData()
    const nextReview = paymentReviewSubscriptions.value.find(item => item.id !== subscription.id && subscriptionDisplayPay(item) === '待复核')
      ?? paymentReviewSubscriptions.value.find(item => item.id !== subscription.id)
    activePaymentSubscriptionId.value = nextReview?.id ?? ''
    ElMessage.success(payload.message)
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(error instanceof Error ? error.message : '复核操作失败')
  }
}

async function forceTakeover(project: Project) {
  const unpaidAmount = projectUnpaidEmployeeAmount(project)
  const message = [
    `将由公司强制接管项目剩余可认购金额 ${formatMoney(projectRemainAmount(project))}。`,
    `公司总认购金额 = 公司固定认购金额 + 公司兜底认购金额 + 公司强制接管认购金额。`,
    unpaidAmount > 0 ? `当前员工已认购未缴款金额 ${formatMoney(unpaidAmount)} 不会被强制接管；除非该认购被释放后重新进入剩余额度。` : '当前无员工已认购未缴款金额。'
  ].join('\n')
  try {
    await ElMessageBox.confirm(message, '强制接管', {
      confirmButtonText: '确认接管',
      cancelButtonText: '取消',
      type: 'warning'
    })
    const payload = await api<{ data: Project; message: string }>(`/api/takeovers/${project.id}/force`, {
      method: 'POST',
      body: JSON.stringify({ operator: `${roleMeta.value.account} · ${roleMeta.value.label}` })
    })
    await loadData()
    ElMessage.success(payload.message)
  } catch (error) {
    if (error === 'cancel' || error === 'close') return
    ElMessage.error(error instanceof Error ? error.message : '强制接管失败')
  }
}

watch(() => authSession.status.value, status => {
  if (status !== 'authenticated') return
  const roleCodes = authSession.permissionInfo.value?.roleCodes ?? authSession.permissionInfo.value?.roles ?? []
  currentRole.value = roleCodes.includes('crowdfunding_super_admin') || roleCodes.includes('super_admin') ? 'super_admin'
    : roleCodes.includes('crowdfunding_finance') || roleCodes.includes('finance') ? 'finance'
    : roleCodes.includes('crowdfunding_admin') || roleCodes.includes('admin') ? 'admin' : 'employee'
  const firstPage = visibleNavGroups.value[0]?.pages[0]?.key
  currentPage.value = firstPage ?? ''
  if (firstPage) void loadData()
})

watch(() => authSession.permissionInfo.value, info => {
  for (const url of privateImageCache.values()) URL.revokeObjectURL(url)
  privateImageCache.clear()
  replaceRows(subscriptions, [])
  replaceRows(receivingCodes, [])
  replaceRows(auditRows, [])
  if (!info) { currentPage.value = ''; return }
  const firstPage = visibleNavGroups.value[0]?.pages[0]?.key
  currentPage.value = firstPage ?? ''
}, { deep: true })
</script>

<template>
  <AuthStateView
    v-if="authSession.status.value !== 'authenticated'"
    :status="authSession.status.value"
    @retry="authSession.retry"
    @login="authSession.startLogin"
    @exit="authSession.logout"
  />
  <div v-else class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">认</div>
        <div>
          <div class="brand-title">内部认购平台</div>
          <div class="brand-subtitle">资金认购 · 线下转账 · OCR 复核</div>
        </div>
      </div>

      <div v-for="group in visibleNavGroups" :key="group.title" class="nav-group">
        <div class="nav-title">{{ group.title }}</div>
        <button
          v-for="page in group.pages"
          :key="page.key"
          class="nav-item"
          :class="{ active: currentPage === page.key }"
          @click="go(page.key)"
        >
          <el-icon><component :is="page.icon" /></el-icon>
          <span>{{ page.label }}</span>
          <b>{{ page.req }}</b>
        </button>
      </div>
    </aside>

    <main class="main">
      <header class="topbar">
        <div>
          <div class="crumb">工作台 / <b>{{ pageTitle }}</b></div>
          <div class="top-hint">{{ authSession.permissionInfo.value?.user.nickname || authSession.permissionInfo.value?.user.username }} · 用户 {{ authSession.permissionInfo.value?.user.username }} · 部门 {{ authSession.permissionInfo.value?.user.deptId || '-' }}</div>
        </div>
        <div class="top-actions">
          <el-button @click="authSession.logout">登出</el-button>
        </div>
      </header>

      <section class="content">
        <section v-if="!currentPage" class="panel empty" data-testid="iam-empty-navigation">当前账号没有可访问的页面，请联系管理员配置 IAM 菜单与权限。</section>
        <template v-if="currentPage === 'projects'">
          <div class="page-head">
            <div>
              <h1>项目列表</h1>
              <p>REQ-SRC-001 / REQ-PRJ-001 · 展示可认购项目、进度、剩余可认购金额与截止时间</p>
            </div>
            <el-segmented v-model="listState" :options="['normal', 'empty', 'loading', 'error']" />
          </div>
          <section class="panel filter-panel">
            <el-select v-model="projectFilters.status" placeholder="状态" style="width: 140px">
              <el-option label="状态：全部" value="全部" />
              <el-option label="未开放" value="未开放" />
              <el-option label="未满额" value="未满额" />
              <el-option label="已满额" value="已满额" />
              <el-option label="已截止" value="已截止" />
              <el-option label="已中断" value="已中断" />
              <el-option label="历史部分已结算（待核实）" value="部分已结算" />
              <el-option label="历史已完结（待核实）" value="已完结" />
            </el-select>
            <el-select v-model="projectFilters.subscriptionStatus" placeholder="认购状态" style="width: 150px">
              <el-option label="认购状态：全部" value="全部" />
              <el-option label="未认购" value="未认购" />
              <el-option label="已认购" value="已认购" />
            </el-select>
            <el-input-number
              v-model="projectFilters.subscriptionCount"
              :min="0"
              :step="1"
              controls-position="right"
              placeholder="认购笔数"
              style="width: 140px"
            />
            <el-input v-model="projectFilters.keyword" placeholder="项目名称 / 编号关键词" />
            <el-button type="primary" @click="projectPage = 1">查询</el-button>
            <el-button @click="resetProjectFilters">重置</el-button>
          </section>
          <section v-if="listState === 'normal'" class="panel">
            <el-table :data="pagedProjects" stripe @sort-change="handleProjectSortChange">
              <el-table-column label="序号" width="70">
                <template #default="{ $index }">{{ (projectPage - 1) * projectPageSize + $index + 1 }}</template>
              </el-table-column>
              <el-table-column label="项目名称" min-width="260">
                <template #default="{ row }">
                  <el-button link type="primary" @click="goProjectDetail(row.id)">{{ row.title }}</el-button>
                </template>
              </el-table-column>
              <el-table-column label="项目状态" align="center" header-align="center" min-width="220">
                <template #default="{ row }">
                  <el-tag :type="row.statusType">{{ row.status === '已完结' || row.status === '部分已结算' ? '历史状态（待核实）' : row.status }}</el-tag>
                  <el-tooltip
                    v-if="row.status === '已中断'"
                    placement="top-start"
                    effect="light"
                    :content="`${row.interruptReason || '已中断认购'} ${row.refundNotice || '请在项目退款事项中核对实际退款进度'}`"
                  >
                    <div class="interrupt-summary">
                      <span>{{ row.interruptReason || '已中断认购' }}</span>
                      <strong>{{ row.refundNotice || '请在项目退款事项中核对实际退款进度' }}</strong>
                    </div>
                  </el-tooltip>
                </template>
              </el-table-column>
              <el-table-column label="认购进度" prop="subscriptionProgress" sortable="custom" min-width="220">
                <template #default="{ row }">
                  <div class="progress-line"><el-progress :percentage="projectProgressPercent(row)" :stroke-width="8" /></div>
                </template>
              </el-table-column>
              <el-table-column prop="remainingAmount" label="剩余可认购金额" sortable="custom" width="170">
                <template #default="{ row }">{{ formatMoney(projectRemainAmount(row)) }}</template>
              </el-table-column>
              <el-table-column label="我的认购状态" width="120">
                <template #default="{ row }">
                  <el-tag :type="getProjectSubscriptionStatus(row.id) === '已认购' ? 'success' : 'info'">{{ getProjectSubscriptionStatus(row.id) }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="我的认购笔数" width="120">
                <template #default="{ row }">
                  <el-button
                    v-if="getProjectSubscriptionCount(row.id) > 0"
                    link
                    type="primary"
                    @click="openProjectSubscriptions(row)"
                  >
                    {{ getProjectSubscriptionCount(row.id) }}
                  </el-button>
                  <span v-else>{{ getProjectSubscriptionCount(row.id) }}</span>
                </template>
              </el-table-column>
              <el-table-column prop="deadline" label="截止认购时间" sortable="custom" width="170" />
              <el-table-column label="操作" width="180">
                <template #default="{ row }">
                  <el-button size="small" @click="goProjectDetail(row.id)">查看详情</el-button>
                  <el-button
                    :disabled="projectRemainAmount(row) <= 0 || row.status !== '未满额'"
                    size="small"
                    type="primary"
                    @click="goProjectDetail(row.id)"
                  >
                    去认购
                  </el-button>
                </template>
              </el-table-column>
            </el-table>
            <div class="pagination-row">
              <el-pagination
                v-model:current-page="projectPage"
                v-model:page-size="projectPageSize"
                :total="filteredProjects.length"
                :page-sizes="[10, 20, 50]"
                layout="total, sizes, prev, pager, next, jumper"
                background
              />
            </div>
          </section>
          <section v-if="listState === 'empty'" class="panel empty">暂无可认购项目</section>
          <section v-if="listState === 'loading'" class="panel"><el-skeleton :rows="5" animated /></section>
          <section v-if="listState === 'error'" class="panel empty danger">列表加载失败（ERR_GATEWAY_504）</section>
        </template>

        <template v-if="currentPage === 'detail'">
          <div class="page-head">
            <div>
              <h1>{{ selectedProject.title }}</h1>
              <p>{{ selectedProject.id }} · REQ-PRJ-001 / REQ-AGR-001 / REQ-SUB-001 / REQ-SUB-002</p>
            </div>
            <div class="page-head-actions">
              <el-button @click="go('projects')">返回项目列表</el-button>
              <el-tag :type="selectedProject.statusType">{{ selectedProject.status === '已完结' || selectedProject.status === '部分已结算' ? '历史状态（待核实）' : selectedProject.status }}</el-tag>
            </div>
          </div>
          <div class="detail-grid">
            <div>
              <section class="panel">
                <h2>项目基础信息</h2>
                <dl class="desc">
                  <dt>采购内容</dt><dd><el-button link type="primary" @click="openProcurementOrderDetail">查看详情</el-button></dd>
                  <dt>项目来源</dt><dd>采购系统 MCP 同步 · 2026-07-01 09:20</dd>
                  <dt>总开放认购金额</dt><dd>{{ formatMoney(selectedProject.total) }}</dd>
                  <template v-if="selectedProjectShareRule">
                    <dt>份额规则</dt><dd>每份 {{ formatMoney(selectedProjectShareRule.sharePrice!) }} · 总 {{ selectedProjectShareRule.totalShares }} 份 · 公司前置 {{ selectedProjectShareRule.companyFrontShares }} 份 · 每人最多 {{ selectedProjectShareRule.maxSharesPerEmployee }} 份</dd>
                    <dt>缴款截止时间</dt><dd>{{ selectedProjectShareRule.paymentCutoffAt || '-' }}</dd>
                    <dt>计划付款日</dt><dd>{{ selectedProjectShareRule.plannedPaymentDate || '-' }}</dd>
                  </template>
                  <dt>认购时间</dt><dd>{{ selectedProjectShareRule?.startAt || '-' }} 至 {{ selectedProject.deadline }}</dd>
                  <dt>收益规则</dt><dd>{{ selectedProjectShareRule ? '回款确认后按认购份数分配本金与利润，分配到分以下的尾差归公司。' : '项目结算后按实缴金额占比分配利润，公司固定认购、公司兜底认购和公司强制接管认购部分收益归公司。' }}</dd>
                </dl>
              </section>
              <section class="panel">
                <h2>认购进度</h2>
                <el-progress :percentage="projectProgressPercent(selectedProject)" :stroke-width="12" />
                <div class="stats">
                  <div><span>已认购金额</span><strong>{{ formatMoney(projectSubscribedAmount(selectedProject)) }}</strong><small>{{ selectedProject.people }} 人参与</small></div>
                  <div><span>剩余可认购</span><strong>{{ formatMoney(projectRemainAmount(selectedProject)) }}</strong><small>{{ selectedProject.deadline }} 截止</small></div>
                  <div><span>公司总认购金额</span><strong class="warn">{{ formatMoney(projectCompanySubscribedAmount(selectedProject)) }}</strong><small>固定 + 兜底 + 强制接管</small></div>
                </div>
              </section>
            </div>
            <section class="panel subscribe-panel">
              <h2>认购操作面板</h2>
              <el-alert
                v-if="selectedProject.status === '已中断'"
                type="error"
                :closable="false"
                class="interrupt-alert"
              >
                本项目已中断认购：{{ selectedProject.interruptReason }}。{{ selectedProject.refundNotice }}
              </el-alert>
              <el-alert type="info" :closable="false" class="remaining-alert">
                {{ selectedProjectShareRule ? `剩余 ${shareRemaining} 份，每人还可认购 ${shareAvailable} 份；每份 ${formatMoney(selectedProjectShareRule.sharePrice!)}` : `剩余可认购 ${formatMoney(projectRemainAmount(selectedProject))}，单次认购最低 ${formatMoney(selectedProjectMinAmount)}` }}
              </el-alert>
              <el-form label-position="top">
                <el-form-item v-if="selectedProjectShareRule" label="认购份数">
                  <el-input-number v-model="subscribeShares" :min="1" :max="Math.max(1, shareAvailable)" :step="1" :precision="0" controls-position="right" />
                  <span class="form-unit">份 · 合计 {{ formatMoney(effectiveSubscribeAmount) }}</span>
                </el-form-item>
                <el-alert v-if="selectedProjectShareRule" type="warning" :closable="false" class="mb12">
                  预计可分配利润：{{ selectedShareEstimatedProfit === null ? '暂无可用采购预算数据' : formatMoney(selectedShareEstimatedProfit) }}。仅按采购单预计销售额减成本测算，不是实际回款或保证收益。
                </el-alert>
                <el-form-item v-else label="认购金额">
                  <el-input-number v-model="subscribeAmount" :min="selectedProjectMinAmount" :max="subscribeAmountMax" :step="100" controls-position="right" />
                </el-form-item>
                <el-alert type="info" :closable="false">提交前将展示当前生效的免责协议，阅读至末尾并确认后才能认购。</el-alert>
              </el-form>
              <el-button v-if="canApi(authSession.permissionInfo.value, 'crowdfunding:subscription:create')" class="wide" type="primary" :disabled="!canSubscribe" @click="startSubscribe">立即认购</el-button>
              <p class="muted">每次提交均需重新确认当前生效的免责协议；项目中断后不可继续认购。</p>
            </section>
          </div>
        </template>

        <template v-if="currentPage === 'mine'">
          <div class="page-head"><div><h1>我的认购</h1><p>员工个人认购、支付与收益视图</p></div></div>
          <section class="panel filter-panel">
            <el-input v-model="mineFilters.keyword" placeholder="认购编号 / 项目关键词" />
            <el-select v-model="mineFilters.project" placeholder="项目" style="width: 220px">
              <el-option label="项目：全部" value="全部" />
              <el-option v-for="project in subscriptionProjectOptions" :key="project" :label="project" :value="project" />
            </el-select>
            <el-select v-model="mineFilters.pay" placeholder="状态" style="width: 150px">
              <el-option label="状态：全部" value="全部" />
              <el-option label="未缴款" value="未缴款" />
              <el-option label="已缴款待审核" value="待复核" />
              <el-option label="缴款被驳回" value="复核驳回" />
              <el-option label="待确认收款" value="待确认收款" />
              <el-option label="已收款" value="已收款" />
              <el-option label="缴款成功" value="已缴款" />
              <el-option label="已释放" value="已释放" />
              <el-option label="缴款逾期" value="缴款逾期" />
            </el-select>
            <el-input-number
              v-model="mineFilters.minAmount"
              :min="0"
              :step="100"
              controls-position="right"
              placeholder="最低金额"
              style="width: 140px"
            />
            <el-input-number
              v-model="mineFilters.maxAmount"
              :min="0"
              :step="100"
              controls-position="right"
              placeholder="最高金额"
              style="width: 140px"
            />
            <el-button type="primary">查询</el-button>
            <el-button @click="resetMineFilters">重置</el-button>
          </section>
          <section class="panel">
            <el-table :data="sortedSubscriptions" stripe>
              <el-table-column label="序号" width="70">
                <template #default="{ $index }">{{ $index + 1 }}</template>
              </el-table-column>
              <el-table-column prop="id" label="认购编号" width="180" />
              <el-table-column label="项目名称" min-width="220">
                <template #default="{ row }">
                  <div>{{ row.project }}</div>
                  <div class="muted">{{ subscriptionProjectCode(row) }}</div>
                </template>
              </el-table-column>
              <el-table-column label="申请认购金额" width="130"><template #default="{ row }">{{ formatMoney(row.amount) }}</template></el-table-column>
              <el-table-column label="认购份数" width="100"><template #default="{ row }">{{ row.shares ?? '旧版' }}</template></el-table-column>
              <el-table-column label="状态" width="190">
                <template #default="{ row }">
                  <el-tag :type="subscriptionPayTagType(row)">{{ subscriptionPayLabel(row) }}</el-tag>
                  <el-tooltip
                    v-if="subscriptionDisplayPay(row) === '复核驳回'"
                    :content="row.rejectReason || '支付截图信息不完整，请重新上传支付成功截图。'"
                    placement="top-start"
                    effect="light"
                  >
                    <div class="reject-reason">{{ row.rejectReason || '支付截图信息不完整，请重新上传支付成功截图。' }}</div>
                  </el-tooltip>
                </template>
              </el-table-column>
              <el-table-column label="截止缴款剩余时长" width="150"><template #default="{ row }">{{ paymentRemaining(row) }}</template></el-table-column>
              <el-table-column label="缴款图上传时间" width="170"><template #default="{ row }">{{ formatDateTime(row.paymentUploadedAt) }}</template></el-table-column>
              <el-table-column label="预估收益" width="150"><template #default="{ row }">{{ subscriptionEstimatedProfit(row) === null ? '暂无估算' : formatMoney(subscriptionEstimatedProfit(row)!) }}<div v-if="row.shares !== undefined" class="muted">仅供参考</div></template></el-table-column>
              <el-table-column label="操作" width="180">
                <template #default="{ row }">
                  <span v-if="['已释放', '缴款逾期'].includes(subscriptionDisplayPay(row))" class="muted">{{ subscriptionDisplayPay(row) }}</span>
                  <el-button v-else size="small" type="primary" @click="handleSubscriptionAction(row)">
                    {{ subscriptionDisplayPay(row) === '未缴款' ? '去支付' : row.action }}
                  </el-button>
                </template>
              </el-table-column>
            </el-table>
          </section>
        </template>

        <template v-if="currentPage === 'payment'">
          <div class="page-head"><div><h1>支付收款码与 OCR 结果</h1><p>REQ-PAY-001 / REQ-PAY-002 / REQ-PAY-003 · 应付 {{ formatMoney(activePaymentAmount) }}</p></div></div>
          <div class="payment-grid">
            <section class="panel qr-panel">
              <h2>项目收款码</h2>
              <section v-if="activePaymentProject" class="payment-project-context">
                <span class="payment-project-context__label">当前认购项目</span>
                <strong>{{ activePaymentProject.title }}</strong>
                <dl class="payment-code-details payment-project-details">
                  <div><dt>项目编号</dt><dd>{{ activePaymentProject.id }}</dd></div>
                  <div><dt>项目来源</dt><dd>{{ activePaymentProject.source }}</dd></div>
                  <div><dt>项目成本金额</dt><dd>{{ formatMoney(projectCostAmount(activePaymentProject)) }}</dd></div>
                  <div><dt>本次应付金额</dt><dd>{{ formatMoney(activePaymentAmount) }}</dd></div>
                  <div><dt>认购规则</dt><dd>{{ activePaymentRule?.ruleName || '未配置已启用规则' }}</dd></div>
                </dl>
              </section>
              <template v-if="activePaymentReceivingCode">
                <div class="payment-code-section-title">项目绑定收款码</div>
                <el-image
                  v-if="activePaymentReceivingCode.imageUrl"
                  class="payment-code-image"
                  :src="activePaymentReceivingCode.imageUrl"
                  :preview-src-list="[activePaymentReceivingCode.imageUrl]"
                  preview-teleported
                  fit="contain"
                />
                <div v-else class="fake-qr"><Grid /></div>
                <strong>{{ activePaymentReceivingCode.subject }}</strong>
                <dl class="payment-code-details">
                  <div><dt>收款码名称</dt><dd>{{ activePaymentReceivingCode.codeName }}</dd></div>
                  <div><dt>账户说明</dt><dd>{{ activePaymentReceivingCode.accountNote }}</dd></div>
                  <div><dt>收款码编号</dt><dd>{{ activePaymentReceivingCode.id }}</dd></div>
                </dl>
                <p v-if="activePaymentReceivingCode.imageUrl">请扫码支付。支付成功后请立即截图，并在本页面上传支付成功截图。</p>
                <p v-else class="payment-code-warning">该收款码暂无图片，请联系管理员或财务上传后再支付。</p>
              </template>
              <template v-else>
                <div class="fake-qr"><Grid /></div>
                <strong>暂无可用项目收款码</strong>
                <p class="payment-code-warning">{{ activePaymentReceivingCodeEmptyText }}</p>
              </template>
            </section>
            <section class="panel">
              <h2>上传支付截图</h2>
              <div class="stats compact payment-recognition-stats">
                <div><span>认购应付金额</span><strong>{{ formatMoney(activePaymentAmount) }}</strong></div>
                <div><span>已识别累计金额</span><strong>{{ formatMoney(activePaymentRecognizedAmount) }}</strong></div>
                <div><span>剩余待识别金额</span><strong :class="{ ok: activePaymentRemainingAmount === 0 }">{{ formatMoney(activePaymentRemainingAmount) }}</strong></div>
              </div>
              <el-upload
                ref="paymentUploadRef"
                drag
                action="#"
                accept="image/png,image/jpeg,image/bmp"
                :auto-upload="false"
                :show-file-list="false"
                :disabled="paymentRecognitionComplete"
                @change="handlePaymentImageChange"
              >
                <el-icon class="upload-icon"><Upload /></el-icon>
                <div>{{ paymentRecognitionComplete ? '累计识别金额已达到认购金额' : '拖拽截图到此处，或点击选择本地转账截图' }}</div>
              </el-upload>
              <div v-if="activePaymentImages.length" class="payment-image-list">
                <div v-for="(image, index) in activePaymentImages" :key="image.id" class="payment-preview">
                  <div class="payment-preview__image payment-preview__image--actual">
                    <el-image
                      class="payment-evidence-image"
                      :src="image.paymentImageUrl"
                      :preview-src-list="activePaymentImages.map(item => item.paymentImageUrl)"
                      :initial-index="index"
                      preview-teleported
                      fit="contain"
                    />
                  </div>
                  <div class="payment-preview__content">
                    <strong>支付截图 {{ index + 1 }}</strong>
                    <p>{{ image.paymentImageName }} · {{ image.uploadedAt }}</p>
                    <p>识别金额 {{ formatMoney(image.recognizedAmount) }} · {{ image.status }}</p>
                    <el-button
                      v-if="image.status === '识别失败'"
                      class="payment-preview__delete"
                      type="danger"
                      plain
                      size="small"
                      @click="deleteFailedPaymentImage(image)"
                    >删除</el-button>
                  </div>
                </div>
              </div>
              <div v-else-if="localPaymentImageUrl" class="payment-preview">
                <div class="payment-preview__image payment-preview__image--actual">
                  <el-image
                    class="payment-evidence-image"
                    :src="localPaymentImageUrl"
                    :preview-src-list="[localPaymentImageUrl]"
                    preview-teleported
                    fit="contain"
                  />
                </div>
                <div>
                  <strong>正在保存本次支付截图</strong>
                </div>
              </div>
              <el-skeleton v-if="ocrState === 'loading'" :rows="3" animated />
              <el-result v-if="ocrState === 'none'" icon="info" title="等待上传" sub-title="上传截图后自动进行 OCR 识别与金额匹配" />
              <el-result v-if="ocrState === 'ok'" icon="success" title="累计金额匹配" :sub-title="`已识别 ${formatMoney(activePaymentRecognizedAmount)}，共 ${activePaymentImages.length} 张截图，状态已更新为已缴款待审核`" />
              <el-result v-if="ocrState === 'mismatch'" icon="warning" title="继续上传支付截图" :sub-title="`已识别 ${formatMoney(activePaymentRecognizedAmount)}，剩余 ${formatMoney(activePaymentRemainingAmount)}`" />
              <el-result v-if="ocrState === 'fail'" icon="warning" title="待财务复核" sub-title="未识别到有效交易金额，截图已保存；你可以继续上传其他支付截图" />
            </section>
          </div>
        </template>

        <template v-if="currentPage === 'adminProjects'">
          <div class="page-head"><div><h1>项目管理</h1><p>{{ limitedAdmin ? '当前可查看待发布采购项目和本人已发布项目' : 'MCP 同步、发布与规则配置入口' }}</p></div><el-button v-if="!limitedAdmin && canApi(authSession.permissionInfo.value, 'crowdfunding:procurement:sync')" type="primary" @click="syncMcp">同步采购系统（MCP）</el-button></div>
          <section class="panel filter-panel">
            <el-input v-model="adminProjectKeyword" clearable placeholder="搜索项目、线下销售单号、创建时间、状态、金额" />
            <el-select v-model="adminProjectStatus" placeholder="项目状态" style="width: 150px">
              <el-option label="项目状态：全部" value="全部" />
              <el-option label="未开放" value="未开放" />
              <el-option label="未满额" value="未满额" />
              <el-option label="已满额" value="已满额" />
              <el-option label="已截止" value="已截止" />
              <el-option label="已中断" value="已中断" />
              <el-option label="历史部分已结算（待核实）" value="部分已结算" />
              <el-option label="历史已完结（待核实）" value="已完结" />
            </el-select>
            <el-select v-model="adminSettlementStatus" placeholder="结算状态" style="width: 150px">
              <el-option label="结算状态：全部" value="全部" />
              <el-option label="未开放" value="未开放" />
              <el-option label="未满额" value="未满额" />
              <el-option label="待结算" value="待结算" />
              <el-option label="已中断" value="已中断" />
              <el-option label="历史待核实" value="历史待核实" />
            </el-select>
            <el-button type="primary">查询</el-button>
            <el-button @click="adminProjectKeyword = ''; adminProjectStatus = '全部'; adminSettlementStatus = '全部'">重置</el-button>
          </section>
          <section class="panel">
              <el-table :data="pagedAdminProjects" stripe @sort-change="handleProjectSortChange">
                <el-table-column label="序号" width="80">
                  <template #default="{ $index }">{{ (adminProjectPage - 1) * adminProjectPageSize + $index + 1 }}</template>
                </el-table-column>
                <el-table-column label="线下销售单号" width="180">
                  <template #default="{ row }">{{ row.offlineSalesOrder || '-' }}</template>
                </el-table-column>
                <el-table-column label="项目" min-width="260">
                  <template #default="{ row }">
                    <div>{{ row.title }}</div>
                  </template>
                </el-table-column>
                <el-table-column label="项目负责人" prop="projectOwner" width="130">
                  <template #default="{ row }">{{ row.projectOwner || '-' }}</template>
                </el-table-column>
                <el-table-column label="创建时间" width="170">
                  <template #default="{ row }">{{ row.createdAt || '-' }}</template>
                </el-table-column>
                <el-table-column label="项目状态" min-width="220">
                  <template #default="{ row }">
                  <el-tag :type="row.statusType">{{ row.status === '已完结' || row.status === '部分已结算' ? '历史状态（待核实）' : row.status }}</el-tag>
                  <el-tooltip
                    v-if="row.status === '已中断'"
                    placement="top-start"
                    effect="light"
                    :content="`${row.interruptReason || '已中断认购'} ${row.refundNotice || '请在项目退款事项中核对实际退款进度'}`"
                  >
                    <div class="interrupt-summary">
                      <span>{{ row.interruptReason || '已中断认购' }}</span>
                      <strong>{{ row.refundNotice || '请在项目退款事项中核对实际退款进度' }}</strong>
                    </div>
                  </el-tooltip>
                </template>
              </el-table-column>
              <el-table-column label="参与认购人数" width="120">
                <template #default="{ row }">{{ getAdminProjectParticipantCount(row) }}</template>
              </el-table-column>
              <el-table-column label="总认购笔数" width="110">
                <template #default="{ row }">{{ getAdminProjectSubscriptionCount(row) }}</template>
              </el-table-column>
              <el-table-column label="认购进度" prop="subscriptionProgress" sortable="custom" min-width="220">
                <template #default="{ row }">
                  <div class="progress-line"><el-progress :percentage="projectProgressPercent(row)" :stroke-width="8" /></div>
                </template>
              </el-table-column>
              <el-table-column prop="remainingAmount" label="剩余可认购金额" sortable="custom" width="160">
                <template #default="{ row }">{{ formatMoney(projectRemainAmount(row)) }}</template>
              </el-table-column>
              <el-table-column label="员工未缴款认购金额" width="180">
                <template #default="{ row }">{{ formatMoney(projectUnpaidEmployeeAmount(row)) }}</template>
              </el-table-column>
              <el-table-column prop="deadline" label="认购截止时间" sortable="custom" width="170" />
              <el-table-column width="150">
                <template #header>
                  <span class="header-with-tip">
                    开放认购金额
                    <el-tooltip content="0≦开放认购金额≦项目成本金额；项目利润 = 项目销售金额 - 项目成本金额" placement="top">
                      <span class="formula-tip">?</span>
                    </el-tooltip>
                  </span>
                </template>
                <template #default="{ row }">{{ formatMoney(row.total) }}</template>
              </el-table-column>
              <el-table-column width="150">
                <template #header>
                  <span class="header-with-tip">
                    开放认购比例
                    <el-tooltip content="开放认购比例 = 开放认购金额 / 项目成本金额 * 100%" placement="top">
                      <span class="formula-tip">?</span>
                    </el-tooltip>
                  </span>
                </template>
                <template #default="{ row }">{{ projectOpenRatio(row) }}%</template>
              </el-table-column>
              <el-table-column label="项目成本金额" width="140">
                <template #default="{ row }">{{ formatMoney(projectCostAmount(row)) }}</template>
              </el-table-column>
              <el-table-column label="项目销售金额" width="140">
                <template #default="{ row }">{{ formatMoney(projectSalesAmount(row)) }}</template>
              </el-table-column>
              <el-table-column width="130">
                <template #header>
                  <span class="header-with-tip">
                    项目利润
                    <el-tooltip content="项目利润 = 项目销售金额 - 项目成本金额" placement="top">
                      <span class="formula-tip">?</span>
                    </el-tooltip>
                  </span>
                </template>
                <template #default="{ row }">{{ formatMoney(projectProfitAmount(row)) }}</template>
              </el-table-column>
              <el-table-column label="公司固定认购金额" width="160">
                <template #default="{ row }">{{ formatMoney(projectCompanyFixedAmount(row)) }}</template>
              </el-table-column>
              <el-table-column label="剩余可强制接管金额" width="180">
                <template #default="{ row }">{{ formatMoney(projectRemainAmount(row)) }}</template>
              </el-table-column>
              <el-table-column label="归属认购利润" width="150">
                <template #default="{ row }">{{ formatMoney(projectProfitAmount(row)) }}</template>
              </el-table-column>
              <el-table-column label="结算状态" width="130">
                <template #default="{ row }">
                  <el-tag :type="projectSettlementTagType(row)">{{ projectSettlementStatus(row.status) }}</el-tag>
                </template>
              </el-table-column>
              <el-table-column label="规则配置" width="110">
                <template #default="{ row }">
                  <el-button v-if="canViewProjectRule(row)" size="small" @click="openRuleDetail(row.id)">查看详情</el-button>
                  <span v-else class="muted">-</span>
                </template>
              </el-table-column>
              <el-table-column label="操作" width="300" fixed="right">
                <template #default="{ row }">
                  <div v-if="!limitedAdmin" class="project-action-group">
                    <el-button
                      v-if="adminProjectActionLayout(row).showPayReview && canApi(authSession.permissionInfo.value, 'crowdfunding:payment-review:query')"
                      size="small"
                      type="primary"
                      plain
                      @click="openPayReviewFromProject(row)"
                    >
                      支付复核
                    </el-button>
                    <el-button
                      v-if="adminProjectActionLayout(row).showSettlement && canApi(authSession.permissionInfo.value, 'crowdfunding:settlement:upload-invoice')"
                      size="small"
                      @click="goProjectSettlement(row)"
                    >
                      核对发票
                    </el-button>
                    <el-button
                      v-if="adminProjectActionLayout(row).showOpen && canApi(authSession.permissionInfo.value, 'crowdfunding:project:open')"
                      size="small"
                      type="primary"
                      @click="updateProjectLifecycle(row, 'open')"
                    >
                      开放
                    </el-button>
                    <el-dropdown
                      v-if="(adminProjectActionLayout(row).showMore || ['已满额', '已截止', '已关闭', '待回款', '回款中', '待分配', '分配中'].includes(row.status)) && (canApi(authSession.permissionInfo.value, 'crowdfunding:project:terminate') || canApi(authSession.permissionInfo.value, 'crowdfunding:project:close') || canApi(authSession.permissionInfo.value, 'crowdfunding:project:reopen') || canApi(authSession.permissionInfo.value, 'crowdfunding:procurement-failure:request') || canApi(authSession.permissionInfo.value, 'crowdfunding:takeover:force'))"
                      trigger="click"
                      popper-class="project-action-menu"
                      @command="handleAdminProjectMoreCommand($event, row)"
                    >
                      <el-button size="small">
                        更多<el-icon class="project-action-more-icon"><ArrowDown /></el-icon>
                      </el-button>
                      <template #dropdown>
                        <el-dropdown-menu>
                          <el-dropdown-item
                            v-if="row.status === '未开放' && canApi(authSession.permissionInfo.value, 'crowdfunding:project:terminate')"
                            command="terminate"
                            class="danger-menu-item"
                          >
                            停止未开放项目
                          </el-dropdown-item>
                          <el-dropdown-item
                            v-if="['未满额', '已满额', '已截止'].includes(row.status) && canApi(authSession.permissionInfo.value, 'crowdfunding:project:close')"
                            command="close"
                            class="danger-menu-item"
                          >关闭众筹单</el-dropdown-item>
                          <el-dropdown-item
                            v-if="row.status === '已关闭' && !row.reopenedByProjectId && canApi(authSession.permissionInfo.value, 'crowdfunding:project:reopen')"
                            command="reopen"
                          >重开众筹单</el-dropdown-item>
                          <el-dropdown-item
                            v-if="['待回款', '回款中', '待分配', '分配中'].includes(row.status) && canApi(authSession.permissionInfo.value, 'crowdfunding:procurement-failure:request')"
                            command="procurementFailure"
                            class="danger-menu-item"
                          >申请采购失败终止</el-dropdown-item>
                          <el-dropdown-item
                            v-if="adminProjectActionLayout(row).showTakeover && canApi(authSession.permissionInfo.value, 'crowdfunding:takeover:force')"
                            command="takeover"
                            class="danger-menu-item"
                            :divided="adminProjectActionLayout(row).showTerminate"
                          >
                            强制接管
                          </el-dropdown-item>
                        </el-dropdown-menu>
                      </template>
                    </el-dropdown>
                  </div>
                </template>
              </el-table-column>
            </el-table>
            <div v-if="filteredAdminProjects.length > adminProjectPageSize" class="pagination-row">
              <el-pagination
                v-model:current-page="adminProjectPage"
                :page-size="adminProjectPageSize"
                :total="filteredAdminProjects.length"
                layout="total, prev, pager, next, jumper"
                background
              />
            </div>
          </section>
        </template>

        <template v-if="currentPage === 'rules'">
          <div class="page-head">
            <div>
              <h1>认购规则配置</h1>
              <p>支持按项目、状态、关键词搜索；每个项目仅可配置一条认购规则</p>
            </div>
            <el-button v-if="canApi(authSession.permissionInfo.value, 'crowdfunding:rule:create')" type="primary" @click="openRuleCreate">创建认购规则</el-button>
          </div>
          <section class="panel filter-panel">
            <label class="filter-field">
              <span class="filter-label">所属项目</span>
              <el-select v-model="ruleFilters.projectId" placeholder="所属项目" style="width: 240px">
                <el-option label="项目：全部" value="全部" />
                <el-option v-for="project in projects" :key="project.id" :label="project.title" :value="project.id" />
              </el-select>
            </label>
            <label class="filter-field">
              <span class="filter-label">规则状态</span>
              <el-select v-model="ruleFilters.status" placeholder="规则状态" style="width: 140px">
                <el-option label="状态：全部" value="全部" />
                <el-option label="未启用" value="未启用" />
                <el-option label="已启用" value="已启用" />
                <el-option label="已停用" value="已停用" />
              </el-select>
            </label>
            <label class="filter-field filter-field--wide">
              <span class="filter-label">关键词</span>
              <el-input v-model="ruleFilters.keyword" placeholder="规则名称 / 项目 / 编码" />
            </label>
            <el-button type="primary" @click="applyRuleFilters">查询</el-button>
            <el-button @click="ruleFilters.keyword = ''; ruleFilters.projectId = '全部'; ruleFilters.status = '全部'; applyRuleFilters()">重置</el-button>
          </section>
          <section class="panel">
            <el-table :data="pagedRules" stripe>
              <el-table-column label="序号" width="80">
                <template #default="{ $index }">{{ (rulePage - 1) * rulePageSize + $index + 1 }}</template>
              </el-table-column>
              <el-table-column label="规则名称" min-width="240">
                <template #default="{ row }">
                  <div>{{ row.ruleName }}</div>
                  <div class="muted">{{ row.id }}</div>
                </template>
              </el-table-column>
              <el-table-column prop="projectName" label="所属项目" min-width="240" />
              <el-table-column label="实际可认购金额" align="right" width="160">
                <template #default="{ row }">{{ formatMoney(row.totalAmount) }}</template>
              </el-table-column>
              <el-table-column label="份额规则" min-width="220">
                <template #default="{ row }">{{ row.sharePrice ? `${formatMoney(row.sharePrice)}/份 · 总 ${row.totalShares} 份 · 公司前置 ${row.companyFrontShares} 份` : '旧版金额规则' }}</template>
              </el-table-column>
              <el-table-column label="单次认购最低金额" align="left" width="160">
                <template #default="{ row }">{{ formatMoney(row.minAmount) }}</template>
              </el-table-column>
              <el-table-column prop="minParticipants" label="开放参与人数" width="120" />
              <el-table-column label="允许多次" width="100">
                <template #default="{ row }"><el-tag :type="row.allowMultiple ? 'success' : 'info'">{{ row.allowMultiple ? '是' : '否' }}</el-tag></template>
              </el-table-column>
              <el-table-column label="公司兜底" width="100">
                <template #default="{ row }"><el-tag :type="row.companyTakeover ? 'warning' : 'info'">{{ row.companyTakeover ? '是' : '否' }}</el-tag></template>
              </el-table-column>
              <el-table-column label="状态" width="100">
                <template #default="{ row }"><el-tag :type="row.status === '已启用' ? 'success' : row.status === '未启用' ? 'warning' : 'info'">{{ row.status }}</el-tag></template>
              </el-table-column>
              <el-table-column prop="endAt" label="认购截止时间" width="170" />
              <el-table-column prop="paymentCutoffAt" label="缴款截止时间" width="170" />
              <el-table-column prop="plannedPaymentDate" label="计划付款日" width="130" />
              <el-table-column prop="updatedAt" label="更新时间" width="170" />
              <el-table-column label="操作" fixed="right" width="260">
                <template #default="{ row }">
                  <el-button
                    v-if="canApi(authSession.permissionInfo.value, 'crowdfunding:rule:update')"
                    size="small"
                    type="primary"
                    plain
                    :disabled="isRuleLocked(row)"
                    @click="openRuleEdit(row)"
                  >
                    修改
                  </el-button>
                  <el-button
                    v-if="row.status === '未启用' && canApi(authSession.permissionInfo.value, 'crowdfunding:rule:change-status')"
                    size="small"
                    type="success"
                    plain
                    @click="updateRuleStatus(row, '已启用')"
                  >
                    启用
                  </el-button>
                  <el-button
                    v-if="row.status === '已启用' && canApi(authSession.permissionInfo.value, 'crowdfunding:rule:change-status')"
                    size="small"
                    type="warning"
                    plain
                    :disabled="isRuleLocked(row)"
                    @click="updateRuleStatus(row, '已停用')"
                  >
                    停用
                  </el-button>
                  <el-button v-if="canApi(authSession.permissionInfo.value, 'crowdfunding:rule:delete')" size="small" type="danger" plain :disabled="isRuleLocked(row)" @click="deleteRule(row)">删除</el-button>
                </template>
              </el-table-column>
            </el-table>
            <div class="pagination-row">
              <el-pagination
                v-model:current-page="rulePage"
                v-model:page-size="rulePageSize"
                :total="filteredRules.length"
                :page-sizes="[10, 20, 50]"
                layout="total, sizes, prev, pager, next, jumper"
                background
              />
            </div>
          </section>
        </template>

        <template v-if="currentPage === 'receivingCode'">
          <div class="page-head">
            <div>
              <h1>项目收款码管理</h1>
              <p>支持创建多条收款码，供管理层在不同项目开放时选择；禁用必须记录理由</p>
            </div>
            <el-button v-if="canApi(authSession.permissionInfo.value, 'crowdfunding:receiving-code:create')" type="primary" @click="openReceivingCodeCreate">创建收款码</el-button>
          </div>
          <section class="panel filter-panel">
            <el-input v-model="receivingCodeFilters.keyword" placeholder="编号 / 主体 / 账户说明 / 收款码 / 修改人 / 禁用理由" />
            <el-select v-model="receivingCodeFilters.status" placeholder="状态" style="width: 150px">
              <el-option label="状态：全部" value="全部" />
              <el-option label="启用" value="启用" />
              <el-option label="已禁用" value="已禁用" />
            </el-select>
            <el-button type="primary">查询</el-button>
            <el-button @click="resetReceivingCodeFilters">重置</el-button>
          </section>
          <section class="panel">
            <el-table :data="filteredReceivingCodes" stripe>
              <el-table-column prop="id" label="编号" width="160" />
              <el-table-column prop="subject" label="收款主体" min-width="180" />
              <el-table-column prop="accountNote" label="账户说明" min-width="220" />
              <el-table-column label="收款码" width="150">
                <template #default="{ row }">
                  <el-image
                    v-if="row.imageUrl"
                    class="code-thumb code-thumb--image"
                    :src="row.imageUrl"
                    :preview-src-list="[row.imageUrl]"
                    preview-teleported
                    fit="contain"
                  />
                  <div v-else class="code-thumb"><Grid /></div>
                  <div class="muted">{{ row.codeName }}</div>
                </template>
              </el-table-column>
              <el-table-column label="状态" width="100">
                <template #default="{ row }"><el-tag :type="row.status === '启用' ? 'success' : 'info'">{{ row.status }}</el-tag></template>
              </el-table-column>
              <el-table-column prop="updatedBy" label="修改人" width="150" />
              <el-table-column prop="updatedAt" label="修改时间" width="170" />
              <el-table-column label="禁用理由" min-width="220">
                <template #default="{ row }">{{ row.disabledReason || '-' }}</template>
              </el-table-column>
              <el-table-column label="操作" fixed="right" width="210">
                <template #default="{ row }">
                  <span v-if="row.status === '启用' && isReceivingCodeImageLocked(row.id)" class="muted">认购后图片已锁定</span>
                  <el-button v-else-if="row.status === '启用' && canApi(authSession.permissionInfo.value, 'crowdfunding:receiving-code:update-image')" size="small" type="primary" plain @click="openReceivingCodeImage(row)">{{ row.imageUrl ? '更换图片' : '上传图片' }}</el-button>
                  <el-button v-if="row.status === '启用' && canApi(authSession.permissionInfo.value, 'crowdfunding:receiving-code:disable')" size="small" type="danger" @click="disableReceivingCode(row)">禁用</el-button>
                  <span v-else class="muted">不可删除</span>
                </template>
              </el-table-column>
            </el-table>
          </section>
        </template>

        <template v-if="currentPage === 'payReview'">
          <div class="page-head">
            <div>
              <h1>支付复核</h1>
              <p>目标项目：{{ paymentReviewTargetLabel }} · 缴款记录 {{ paymentReviewSubscriptions.length }} 笔，其中待审核 {{ pendingPaymentReviewCount }} 笔</p>
            </div>
            <div class="page-head-actions">
              <el-button @click="backToAdminProjects">返回项目管理</el-button>
            </div>
          </div>
          <div class="review-grid">
            <section class="panel">
              <h2>目标项目缴款记录</h2>
              <div
                v-for="item in paymentReviewSubscriptions"
                :key="item.id"
                class="queue"
                :class="{ active: activeReviewSubscription?.id === item.id }"
                @click="activePaymentSubscriptionId = item.id"
              >
                <strong>{{ reviewPaymentId(item) }}</strong>
                <span>{{ employeeNameMap[item.userId ?? 'employee01'] ?? '员工' }} · {{ formatMoney(item.amount) }}</span>
                <small>上传时间：{{ formatDateTime(item.paymentUploadedAt) }}</small>
                <el-tag :type="subscriptionPayTagType(item)" size="small">{{ subscriptionPayLabel(item) }}</el-tag>
              </div>
              <el-empty v-if="!paymentReviewSubscriptions.length" :description="`${selectedProject?.title ?? '当前项目'}暂无缴款记录`" />
            </section>
            <section class="panel">
              <h2>复核详情</h2>
              <div class="review-project-meta">
                <div><span>项目名称</span><strong>{{ activeReviewProjectName }}</strong></div>
                <div><span>项目编码</span><strong>{{ activeReviewProjectCode }}</strong></div>
              </div>
              <div class="review-project-meta">
                <div><span>复核员工</span><strong>{{ activeReviewEmployeeLabel }}</strong></div>
                <div><span>上传截图时间</span><strong>{{ formatDateTime(activeReviewUploadedAt) }}</strong></div>
                <div><span>识别支付成功时间</span><strong>{{ formatDateTime(activeReviewPaymentSuccessAt) }}</strong></div>
                <div><span>复核人员</span><strong>{{ activeReviewReviewedBy }}</strong></div>
                <div><span>复核操作时间</span><strong>{{ activeReviewReviewedAt }}</strong></div>
              </div>
              <div v-if="activeReviewPaymentImages.length" class="payment-image-list review-payment-image-list">
                <div v-for="(image, index) in activeReviewPaymentImages" :key="image.id" class="payment-preview review-payment-preview">
                  <div class="payment-preview__image payment-preview__image--actual">
                    <el-image
                      class="payment-evidence-image"
                      :src="image.paymentImageUrl"
                      :preview-src-list="activeReviewPaymentImages.map(item => item.paymentImageUrl)"
                      :initial-index="index"
                      preview-teleported
                      fit="contain"
                    />
                  </div>
                  <div class="review-payment-preview__content">
                    <strong>实际上传截图 {{ index + 1 }}</strong>
                    <p>{{ image.paymentImageName }} · {{ image.uploadedAt }}</p>
                    <p>识别金额 {{ formatMoney(image.recognizedAmount) }} · {{ image.status }}</p>
                  </div>
                </div>
              </div>
              <div v-else class="payment-preview review-payment-preview">
                <div class="payment-preview__image payment-preview__image--actual">
                  <el-empty description="暂无已上传图片" :image-size="48" />
                </div>
                <div class="review-payment-preview__content">
                  <strong>未留存实际截图</strong>
                  <p>该历史记录没有可供复核的实际图片。</p>
                </div>
              </div>
              <div class="stats compact">
                <div><span>应付金额</span><strong>{{ formatMoney(activeReviewAmount) }}</strong></div>
                <div><span>累计 OCR 金额</span><strong>{{ formatMoney(activeReviewRecognizedAmount) }}</strong></div>
                <div v-if="activeReviewSubscription?.shares === undefined"><span>置信度</span><strong class="ok">98%</strong></div>
              </div>
              <div v-if="activeReviewSubscription?.shares !== undefined" class="review-project-meta">
                <div><span>认购份数</span><strong>{{ activeReviewSubscription.shares }} 份</strong></div>
                <div><span>实际到账金额</span>
                  <el-input-number v-if="activeReviewIsPending" v-model="reviewActualPaidAmount" :min="0.01" :precision="2" controls-position="right" />
                  <strong v-else>{{ activeReviewSubscription.actualPaidAmount !== undefined ? formatMoney(activeReviewSubscription.actualPaidAmount) : '-' }}</strong>
                </div>
                <div><span>交易流水号</span>
                  <el-input v-if="activeReviewIsPending" v-model="reviewTransactionNo" maxlength="100" placeholder="请以银行实际到账记录为准" />
                  <strong v-else>{{ activeReviewSubscription.transactionNo || '-' }}</strong>
                </div>
              </div>
              <el-alert v-if="activeReviewSubscription?.shares !== undefined && activeReviewIsPending" type="warning" :closable="false" title="通过前须核对认购金额、实际到账金额及凭证识别金额一致；OCR 结果不能代替财务核实。" />
              <el-input type="textarea" placeholder="驳回或部分缴款时填写原因" :disabled="!activeReviewIsPending" />
              <div v-if="activeReviewIsPending" class="actions-row">
                <el-button v-if="canApi(authSession.permissionInfo.value, 'crowdfunding:payment-review:approve')" type="primary" @click="submitPaymentReview('pass')">通过</el-button>
                <el-button v-if="canApi(authSession.permissionInfo.value, 'crowdfunding:payment-review:reject')" type="danger" @click="submitPaymentReview('reject')">驳回</el-button>
                <el-button v-if="canApi(authSession.permissionInfo.value, 'crowdfunding:payment-review:partial')" @click="submitPaymentReview('partial')">标记部分缴款</el-button>
              </div>
              <el-alert v-else :title="activeReviewReadOnlyText" type="info" :closable="false" show-icon />
            </section>
          </div>
        </template>

        <ProcurementPaymentPage
          v-if="currentPage === 'procurementPayment'"
          :projects="projects"
          :can-register="canApi(authSession.permissionInfo.value, 'crowdfunding:procurement-payment:register')"
          :can-upload-proof="canApi(authSession.permissionInfo.value, 'crowdfunding:procurement-payment:proof-upload')"
          @registered="loadData"
        />

        <CustomerReceiptsPage
          v-if="currentPage === 'customerReceipts' && (currentRole === 'finance' || currentRole === 'super_admin')"
          :projects="projects" :role="currentRole"
          :can-register="canApi(authSession.permissionInfo.value, 'crowdfunding:receipt:register')"
          :can-upload-proof="canApi(authSession.permissionInfo.value, 'crowdfunding:receipt:proof-upload')"
          :can-review="canApi(authSession.permissionInfo.value, 'crowdfunding:receipt:review')"
          :can-register-difference="canApi(authSession.permissionInfo.value, 'crowdfunding:receipt:difference-register')"
          @updated="loadData"
        />

        <MyPayoutsPage v-if="currentPage === 'myPayouts' && currentRole === 'employee'" />

        <ExceptionFundsPage
          v-if="currentPage === 'exceptionFunds' && (currentRole === 'finance' || currentRole === 'super_admin')"
          :projects="projects" :role="currentRole"
          :can-register="canApi(authSession.permissionInfo.value, 'crowdfunding:exception-fund:register')"
          :can-upload-proof="canApi(authSession.permissionInfo.value, 'crowdfunding:exception-fund:proof-upload')"
          :can-refund="canApi(authSession.permissionInfo.value, 'crowdfunding:exception-fund:refund')"
          :can-upload-refund-proof="canApi(authSession.permissionInfo.value, 'crowdfunding:exception-fund:refund-proof-upload')"
          :can-confirm-refund="canApi(authSession.permissionInfo.value, 'crowdfunding:exception-fund:refund-confirm')"
          :can-transfer="canApi(authSession.permissionInfo.value, 'crowdfunding:exception-fund:transfer')"
          :can-review-transfer="canApi(authSession.permissionInfo.value, 'crowdfunding:exception-fund:transfer-review')"
          :can-assign-project="canApi(authSession.permissionInfo.value, 'crowdfunding:exception-fund:assign-project')"
          @updated="loadData"
        />

        <ProjectRefundsPage
          v-if="currentPage === 'projectRefunds' && (currentRole === 'finance' || currentRole === 'super_admin')"
          :projects="projects" :role="currentRole"
          :can-register="canApi(authSession.permissionInfo.value, 'crowdfunding:project-refund:register')"
          :can-upload-proof="canApi(authSession.permissionInfo.value, 'crowdfunding:project-refund:proof-upload')"
          :can-finish-close="canApi(authSession.permissionInfo.value, 'crowdfunding:project:finish-close')"
          :can-proxy-query="canApi(authSession.permissionInfo.value, 'crowdfunding:project-refund-proxy:query')"
          :can-proxy-request="canApi(authSession.permissionInfo.value, 'crowdfunding:project-refund-proxy:request')"
          :can-proxy-review="canApi(authSession.permissionInfo.value, 'crowdfunding:project-refund-proxy:review')"
          @updated="loadData"
        />

        <ProcurementFailurePage
          v-if="currentPage === 'procurementFailure' && (currentRole === 'admin' || currentRole === 'finance' || currentRole === 'super_admin')"
          :projects="projects" :role="currentRole"
          :can-query-requests="canApi(authSession.permissionInfo.value, 'crowdfunding:procurement-failure:query')"
          :can-review="canApi(authSession.permissionInfo.value, 'crowdfunding:procurement-failure:review')"
          :can-query-refunds="canApi(authSession.permissionInfo.value, 'crowdfunding:supplier-refund:query')"
          :can-register-refund="canApi(authSession.permissionInfo.value, 'crowdfunding:supplier-refund:register')"
          :can-upload-proof="canApi(authSession.permissionInfo.value, 'crowdfunding:supplier-refund:proof-upload')"
          :can-finish="canApi(authSession.permissionInfo.value, 'crowdfunding:procurement-failure:finish')"
          :can-query-receipts="canApi(authSession.permissionInfo.value, 'crowdfunding:receipt:query')"
          :can-query-receipt-refunds="canApi(authSession.permissionInfo.value, 'crowdfunding:receipt-termination-refund:query')"
          :can-register-receipt-refund="canApi(authSession.permissionInfo.value, 'crowdfunding:receipt-termination-refund:register')"
          :can-upload-receipt-refund-proof="canApi(authSession.permissionInfo.value, 'crowdfunding:receipt-termination-refund:proof-upload')"
          :can-review-receipt-refund="canApi(authSession.permissionInfo.value, 'crowdfunding:receipt-termination-refund:review')"
          @updated="loadData"
        />

        <DistributionOrdersPage
          v-if="currentPage === 'distributionOrders' && (currentRole === 'finance' || currentRole === 'super_admin')"
          :projects="projects" :role="currentRole"
          :can-generate="canApi(authSession.permissionInfo.value, 'crowdfunding:distribution:generate')"
          :can-approve="canApi(authSession.permissionInfo.value, 'crowdfunding:distribution:approve')"
          :can-reject="canApi(authSession.permissionInfo.value, 'crowdfunding:distribution:reject')"
          :can-void="canApi(authSession.permissionInfo.value, 'crowdfunding:distribution:void')"
          :can-query-cost="canApi(authSession.permissionInfo.value, 'crowdfunding:cost:query')"
          :can-register-cost="canApi(authSession.permissionInfo.value, 'crowdfunding:cost:register')"
          :can-upload-cost-proof="canApi(authSession.permissionInfo.value, 'crowdfunding:cost:proof-upload')"
          :can-review-cost="canApi(authSession.permissionInfo.value, 'crowdfunding:cost:review')"
          :can-register-payout="canApi(authSession.permissionInfo.value, 'crowdfunding:payout:register')"
          :can-upload-payout-proof="canApi(authSession.permissionInfo.value, 'crowdfunding:payout:proof-upload')"
          :can-reply-payout-issue="canApi(authSession.permissionInfo.value, 'crowdfunding:payout:issue-reply')"
          :can-query-financial-reconciliation="canApi(authSession.permissionInfo.value, 'crowdfunding:financial-reconciliation:query')"
          :can-close="canApi(authSession.permissionInfo.value, 'crowdfunding:distribution:close')"
          @updated="loadData"
        />

        <template v-if="currentPage === 'settlement'">
          <div class="page-head">
            <div>
              <h1>发票凭证核对</h1>
              <p>{{ selectedProject.title }} · {{ selectedProject.id }} · 核对发票凭证与认购记录</p>
            </div>
            <div class="page-head-actions">
              <el-tag :type="projectSettlementTagType(selectedProject)">{{ projectSettlementStatus(selectedProject.status) }}</el-tag>
              <el-button @click="backToAdminProjects">返回项目管理</el-button>
            </div>
          </div>
          <section class="panel">
            <section class="settlement-project-info">
              <h2>归属项目信息</h2>
              <dl class="desc">
                <dt>项目名称</dt>
                <dd>{{ selectedProject.title }}</dd>
                <dt>项目编号</dt>
                <dd>{{ selectedProject.id }}</dd>
                <dt>项目状态</dt>
                <dd><el-tag :type="selectedProject.statusType">{{ selectedProject.status === '已完结' || selectedProject.status === '部分已结算' ? '历史状态（待核实）' : selectedProject.status }}</el-tag></dd>
                <dt>历史结算状态</dt>
                <dd><el-tag :type="projectSettlementTagType(selectedProject)">{{ projectSettlementStatus(selectedProject.status) }}</el-tag></dd>
                <dt>截止认购时间</dt>
                <dd>{{ selectedProject.deadline }}</dd>
                <dt>归属管理端</dt>
                <dd>项目管理 / {{ selectedProject.id }}</dd>
                <dt>预计项目销售额</dt>
                <dd class="settlement-money">{{ formatMoney(projectSalesAmount(selectedProject)) }}</dd>
                <dt>预计采购与执行成本</dt>
                <dd class="settlement-money">{{ formatMoney(projectCostAmount(selectedProject)) }}</dd>
                <dt>预计项目利润</dt>
                <dd class="settlement-money">{{ formatMoney(projectProfitAmount(selectedProject)) }}</dd>
                <dt>已确认其他成本</dt>
                <dd>待录入核实</dd>
                <dt>实际可分配利润</dt>
                <dd>待实收、补款及成本核实后计算</dd>
              </dl>
            </section>
            <el-alert title="本页仅核对发票凭证，不代表客户款项实收或完成分润。分配利润以已复核客户回款和公司补款为基础，扣除补款返还、超出应收的差异、采购实付及其他已确认成本；尾差归公司。" type="info" :closable="false" show-icon />
            <el-alert v-if="selectedProject.status === '已完结' || selectedProject.status === '部分已结算'" title="历史项目可能因旧版发票凭证累计而改变结算状态；在核实回款、分配、打款和对账前，不应视为已结单。" type="warning" :closable="false" show-icon />
            <div class="settlement-balance-summary">
              <div><span>预计项目销售额</span><strong>{{ formatMoney(projectSalesAmount(selectedProject)) }}</strong></div>
              <div><span>累计已确认凭证金额</span><strong>{{ formatMoney(selectedProjectSettledAmount) }}</strong></div>
              <div><span>剩余待核对凭证金额</span><strong>{{ formatMoney(selectedProjectRemainingSettlementAmount) }}</strong></div>
            </div>
            <el-alert
              v-if="selectedProjectSettlementCompleted"
              title="凭证金额已达到预计销售额，发票上传入口已关闭；实际回款及分润仍需单独核实。"
              type="success"
              :closable="false"
              show-icon
            />
            <el-table data-testid="settlement-subscription-table" class="settlement-table" :data="settlementProjectSubscriptions" stripe>
              <el-table-column prop="project" label="项目" min-width="260" />
              <el-table-column label="认购人员" min-width="170">
                <template #default="{ row }">{{ settlementSubscriberLabel(row, employeeNameMap) }}</template>
              </el-table-column>
              <el-table-column label="缴款时间" min-width="180">
                <template #default="{ row }">{{ settlementPaymentTime(row) }}</template>
              </el-table-column>
              <el-table-column label="有效认购" align="right" min-width="120"><template #default="{ row }">{{ formatMoney(row.amount) }}</template></el-table-column>
              <el-table-column label="预估收益" align="right" min-width="120"><template #default="{ row }">{{ subscriptionEstimatedProfit(row) === null ? '暂无估算' : formatMoney(subscriptionEstimatedProfit(row)!) }}</template></el-table-column>
            </el-table>
            <div v-if="!selectedProjectSettlementCompleted" class="actions-row">
              <el-button type="primary" :disabled="settlementInvoiceVisible" @click="startSettlement">
                {{ settlementInvoiceVisible ? '等待补充发票凭证' : '核对发票凭证' }}
              </el-button>
            </div>
            <section
              v-if="settlementInvoiceVisible && !selectedProjectSettlementCompleted"
              data-testid="settlement-invoice-upload"
              class="settlement-invoice"
            >
              <div class="settlement-invoice__head">
                <div>
                  <h2>上传发票</h2>
                  <p>上传项目发票后自动识别票面金额，仅用于核对凭证。</p>
                </div>
                <el-tag :type="invoiceOcrState === 'ok' ? 'success' : invoiceOcrState === 'fail' ? 'danger' : 'info'">
                  {{ invoiceOcrState === 'ok' ? '已识别' : invoiceOcrState === 'loading' ? '识别中' : invoiceOcrState === 'fail' ? '识别失败' : '待上传' }}
                </el-tag>
              </div>
              <div class="payment-preview invoice-preview">
                <el-upload
                  data-testid="settlement-invoice-upload-card"
                  class="invoice-upload-card"
                  drag
                  action="#"
                  accept="image/png,image/jpeg,image/webp"
                  :auto-upload="false"
                  :show-file-list="false"
                  @change="runInvoiceOcr"
                >
                  <div v-if="!invoiceImageUrl" class="invoice-upload-card__empty">
                    <el-icon class="upload-icon"><Upload /></el-icon>
                    <strong>上传发票凭证</strong>
                    <span>点击或拖拽图片到此处</span>
                    <small>支持 PNG、JPG、WebP，最大 5MB</small>
                  </div>
                  <div v-else class="invoice-upload-card__preview">
                    <img :src="invoiceImageUrl" :alt="invoiceImageName || '待确认发票凭证'" />
                    <div class="invoice-upload-card__toolbar">
                      <el-button size="small" plain @click.stop="openInvoicePreview">预览</el-button>
                      <el-button size="small" type="primary">重新上传</el-button>
                      <el-button size="small" type="danger" plain :loading="invoiceDeleting" :disabled="settlementSubmitting" @click.stop="removePendingInvoice">删除</el-button>
                    </div>
                  </div>
                </el-upload>
                <div class="invoice-ocr-result">
                  <template v-if="invoiceImageUrl">
                    <span>已上传：{{ invoiceImageName }}</span>
                  </template>
                  <template v-else>
                    <strong class="invoice-upload-card__guide-title">等待上传凭证</strong>
                    <p>图片上传后将在此显示固定识别字段与凭证校验结果。</p>
                  </template>
                  <template v-if="invoiceOcrState === 'loading'">
                    <strong>识别中...</strong>
                    <p>正在通过发票 OCR 服务识别已上传图片。</p>
                  </template>
                  <template v-else-if="invoiceOcrState === 'ok' && invoiceOcrResult">
                    <dl v-if="invoiceOcrResult.fields.length" class="invoice-ocr-fields">
                      <template v-for="field in invoiceOcrResult.fields" :key="field.key">
                        <dt>{{ field.label }}</dt>
                        <dd>{{ field.value }}</dd>
                      </template>
                    </dl>
                    <p v-else>识别完成，但接口未返回可展示字段。</p>
                    <p v-if="invoiceOcrResult.taskNo">识别任务号：{{ invoiceOcrResult.taskNo }}</p>
                  </template>
                  <p v-else-if="invoiceOcrState === 'fail'" class="invoice-ocr-error">{{ invoiceOcrError }}</p>
                </div>
              </div>
              <el-image-viewer
                v-if="invoicePreviewVisible && invoiceImageUrl"
                :url-list="[invoiceImageUrl]"
                @close="invoicePreviewVisible = false"
              />
              <el-alert
                v-if="currentInvoiceExceedsRemaining"
                :title="`交易金额 ${formatMoney(currentInvoiceAmount ?? 0)} 超过剩余待核对凭证金额 ${formatMoney(selectedProjectRemainingSettlementAmount)}，不能确认。`"
                type="error"
                :closable="false"
                show-icon
              />
              <div v-if="invoiceOcrState === 'ok'" class="actions-row settlement-confirm-actions">
                <el-button
                  v-if="currentInvoiceCanConfirm"
                  type="primary"
                  :loading="settlementSubmitting"
                  @click="confirmSettlementInvoice"
                >确认发票凭证</el-button>
                <span v-else-if="currentInvoiceAmount === undefined" class="invoice-ocr-error">未识别到交易金额，暂不能确认凭证。</span>
              </div>
            </section>
            <section data-testid="settlement-invoice-records" class="settlement-invoice-records">
              <div class="settlement-invoice-records__head">
                <div>
                <h2>发票识别记录</h2>
                  <p>仅展示已核对的发票凭证，不代表客户实收；记录按确认时间倒序排列。</p>
                </div>
                <el-tag type="info">{{ selectedProject.settlementInvoices?.length ?? 0 }} 条</el-tag>
              </div>
              <el-empty
                v-if="!selectedProject.settlementInvoices?.length"
                description="暂无已确认的发票识别记录"
                :image-size="72"
              />
              <div v-else class="settlement-invoice-record-list">
                <article
                  v-for="invoice in [...(selectedProject.settlementInvoices ?? [])].reverse()"
                  :key="invoice.id"
                  class="settlement-invoice-record"
                >
                  <div class="settlement-invoice-record__image">
                    <el-image
                      v-if="invoice.imageUrl"
                      :src="invoice.imageUrl"
                      :preview-src-list="[invoice.imageUrl]"
                      preview-teleported
                      fit="contain"
                    />
                    <el-empty v-else description="历史记录未保存图片" :image-size="48" />
                  </div>
                  <div class="settlement-invoice-record__content">
                    <div class="settlement-invoice-record__title">
                      <strong>{{ invoice.fileName || '未命名发票' }}</strong>
                      <el-tag :type="invoice.resultStatus === '已完结' || invoice.resultStatus === '部分已结算' ? 'warning' : 'info'">
                        {{ invoice.resultStatus === '已完结' || invoice.resultStatus === '部分已结算' ? '历史状态待核实' : invoice.resultStatus ?? '已确认' }}
                      </el-tag>
                    </div>
                    <dl class="invoice-ocr-fields settlement-invoice-record__fields">
                      <dt>交易日期</dt><dd>{{ invoice.transactionDate || '未识别' }}</dd>
                      <dt>付款人</dt><dd>{{ invoice.payer || '未识别' }}</dd>
                      <dt>收款人</dt><dd>{{ invoice.payee || '未识别' }}</dd>
                      <dt>交易金额</dt><dd>{{ formatMoney(invoice.amount) }}</dd>
                      <dt>确认后累计</dt><dd>{{ invoice.settledAmountAfter === undefined ? '-' : formatMoney(invoice.settledAmountAfter) }}</dd>
                      <dt>确认后剩余</dt><dd>{{ invoice.remainingAmountAfter === undefined ? '-' : formatMoney(invoice.remainingAmountAfter) }}</dd>
                    </dl>
                    <div class="settlement-invoice-record__meta">
                      <span>确认时间：{{ invoice.confirmedAt || '-' }}</span>
                      <span>操作人：{{ invoice.operator || '-' }}</span>
                    </div>
                  </div>
                </article>
              </div>
            </section>
          </section>
        </template>

        <template v-if="currentPage === 'takeovers'">
          <div class="page-head"><div><h1>公司兜底管理</h1><p>公司总认购金额 = 公司固定认购金额 + 公司兜底认购金额 + 公司强制接管认购金额</p></div></div>
          <section class="panel">
            <el-table :data="projects.filter(item => projectRemainAmount(item) > 0 || projectCompanyTakeoverAmount(item) > 0)" stripe>
              <el-table-column prop="title" label="项目" min-width="260" />
              <el-table-column label="公司固定认购金额" align="right" width="160"><template #default="{ row }">{{ formatMoney(projectCompanyFixedAmount(row)) }}</template></el-table-column>
              <el-table-column label="公司兜底认购金额" align="right" width="160"><template #default="{ row }">{{ formatMoney(projectCompanyTakeoverAmount(row)) }}</template></el-table-column>
              <el-table-column label="公司兜底份数" align="right" width="130"><template #default="{ row }">{{ row.companyBackstopShares ?? (row.ruleId && rules.find(rule => rule.id === row.ruleId)?.sharePrice ? 0 : '旧版') }}</template></el-table-column>
              <el-table-column label="公司强制接管认购金额" align="right" width="190"><template #default="{ row }">{{ formatMoney(projectCompanyForcedTakeoverAmount(row)) }}</template></el-table-column>
              <el-table-column label="公司总认购金额" align="right" width="160"><template #default="{ row }">{{ formatMoney(projectCompanySubscribedAmount(row)) }}</template></el-table-column>
              <el-table-column label="剩余可强制接管金额" align="right" width="180"><template #default="{ row }">{{ formatMoney(projectRemainAmount(row)) }}</template></el-table-column>
              <el-table-column label="员工未缴款认购金额" align="right" width="180"><template #default="{ row }">{{ formatMoney(projectUnpaidEmployeeAmount(row)) }}</template></el-table-column>
              <el-table-column prop="deadline" label="截止时间" width="170" />
              <el-table-column label="操作位置" fixed="right" width="210">
                <template #default="{ row }">
                  <span class="muted">{{ row.status === '未满额' && projectRemainAmount(row) > 0 ? '请在项目管理页执行' : '无需接管' }}</span>
                </template>
              </el-table-column>
            </el-table>
            <p class="muted">强制接管入口已移至管理端“项目管理”页；此页仅保留公司兜底与接管金额概览。强制接管仅存在项目认购未满额阶段，不会强制接管员工已认购未缴款金额。</p>
          </section>
        </template>

        <template v-if="currentPage === 'agreements'">
          <div class="page-head"><div><h1>免责协议版本</h1><p>新版本提交后立即生效，历史版本与确认记录只读留存</p></div><el-button v-if="canApi(authSession.permissionInfo.value, 'crowdfunding:agreement:manage')" type="primary" @click="agreementFormVisible = true">新增版本</el-button></div>
          <section class="panel">
            <el-table :data="agreementVersions" empty-text="暂无协议版本">
              <el-table-column prop="version" label="版本号" width="100" />
              <el-table-column prop="title" label="协议标题" min-width="230" />
              <el-table-column prop="status" label="状态" width="110" />
              <el-table-column prop="effectiveAt" label="生效时间" width="220" />
              <el-table-column prop="createdBy" label="创建人" width="180" />
              <el-table-column label="操作" width="190"><template #default="{ row }">
                <el-button link type="primary" @click="ElMessageBox.alert(row.body, `协议 V${row.version} · ${row.title}`, { confirmButtonText: '关闭' })">查看</el-button>
                <el-button link type="primary" @click="showAgreementConfirmations(row.version)">确认记录</el-button>
              </template></el-table-column>
            </el-table>
            <el-pagination v-model:current-page="agreementVersionPage" :page-size="10" :total="agreementVersionTotal" layout="total, prev, pager, next" />
          </section>
        </template>

        <template v-if="currentPage === 'rbac'">
          <div class="page-head"><div><h1>权限管理</h1><p>角色与资金敏感权限矩阵</p></div></div>
          <section class="panel">
            <el-table :data="[
              { feature: '员工认购', employee: 'C/R/U(本人)', admin: 'R', finance: 'R', super: 'R' },
              { feature: 'OCR 复核', employee: '—', admin: 'R', finance: 'R/U/A', super: 'R/U/A' },
              { feature: '公司兜底', employee: '—', admin: 'R', finance: 'R', super: 'R/U/X' },
              { feature: '审计日志', employee: '—', admin: 'R', finance: 'R(财务相关)', super: 'R' }
            ]" stripe>
              <el-table-column prop="feature" label="功能" />
              <el-table-column prop="employee" label="员工" />
              <el-table-column prop="admin" label="管理员" />
              <el-table-column prop="finance" label="财务" />
              <el-table-column prop="super" label="公司超级管理员" />
            </el-table>
          </section>
        </template>

        <template v-if="currentPage === 'audit'">
          <div class="page-head"><div><h1>审计日志</h1><p>全部资金动作可追溯，支持 before / after 差异对比</p></div></div>
          <section class="panel filter-panel">
            <label class="filter-field">
              <span class="filter-label">操作人</span>
              <el-input v-model="auditFilters.actor" clearable placeholder="搜索操作人" />
            </label>
            <label class="filter-field">
              <span class="filter-label">结果</span>
              <el-select v-model="auditFilters.result">
                <el-option label="全部" value="全部" />
                <el-option label="成功" value="成功" />
                <el-option label="失败" value="失败" />
              </el-select>
            </label>
            <el-button type="primary">查询</el-button>
            <el-button @click="auditFilters.actor = ''; auditFilters.result = '全部'">重置</el-button>
          </section>
          <section class="panel">
            <el-table :data="filteredAuditRows" stripe>
              <el-table-column prop="time" label="时间" width="180" />
              <el-table-column prop="actor" label="操作人" width="150" />
              <el-table-column prop="action" label="动作" />
              <el-table-column prop="target" label="目标" width="180" />
              <el-table-column prop="result" label="结果" width="100" />
              <el-table-column label="操作" width="120"><template #default="{ row }"><el-button link type="primary" @click="selectedAudit = row; auditVisible = true">查看差异</el-button></template></el-table-column>
            </el-table>
          </section>
        </template>
      </section>
    </main>

    <el-dialog v-model="procurementDetailVisible" title="采购订单详情" width="900px">
      <section v-loading="procurementDetailLoading" class="procurement-detail-content">
        <el-alert
          v-if="procurementDetailError"
          type="error"
          :closable="false"
          :title="procurementDetailError"
        />
        <el-descriptions v-else-if="procurementOrderDetail" :column="2" border>
          <el-descriptions-item label="项目名称" :span="2">{{ procurementOrderDetail.projectName }}</el-descriptions-item>
          <el-descriptions-item label="采购订单编号">{{ procurementOrderDetail.id }}</el-descriptions-item>
          <el-descriptions-item label="销售单号">{{ procurementOrderDetail.sellOrder }}</el-descriptions-item>
          <el-descriptions-item label="采购名称">{{ procurementOrderDetail.purchasingName }}</el-descriptions-item>
          <el-descriptions-item label="采购状态（代码）">{{ procurementOrderDetail.purchasingStatus }}</el-descriptions-item>
          <el-descriptions-item label="项目类型（代码）">{{ procurementOrderDetail.projectType }}</el-descriptions-item>
          <el-descriptions-item label="采购类型（代码）">{{ procurementOrderDetail.purchasingType }}</el-descriptions-item>
          <el-descriptions-item label="采购数量">{{ procurementOrderDetail.purchaseQuantity }}</el-descriptions-item>
          <el-descriptions-item label="负责人">{{ procurementOrderDetail.responsiblePerson }}</el-descriptions-item>
          <el-descriptions-item label="项目成本金额">{{ formatMoney(procurementOrderDetail.totalCostPrice) }}</el-descriptions-item>
          <el-descriptions-item label="项目销售金额">{{ formatMoney(procurementOrderDetail.totalSellingPrice) }}</el-descriptions-item>
          <el-descriptions-item label="项目成交金额">{{ formatMoney(procurementOrderDetail.totalTransactionPrice) }}</el-descriptions-item>
          <el-descriptions-item label="采购时间">{{ procurementOrderDetail.purchasingTime }}</el-descriptions-item>
          <el-descriptions-item label="配送要求" :span="2">{{ procurementOrderDetail.deliveryRequirements }}</el-descriptions-item>
          <el-descriptions-item label="设计要求" :span="2">{{ procurementOrderDetail.designRequirements }}</el-descriptions-item>
          <el-descriptions-item label="订单备注" :span="2">{{ procurementOrderDetail.remark }}</el-descriptions-item>
          <el-descriptions-item label="采购备注" :span="2">{{ procurementOrderDetail.purchasingRemark }}</el-descriptions-item>
        </el-descriptions>
      </section>
      <template #footer>
        <el-button @click="procurementDetailVisible = false">关闭</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="agreementVisible" :title="`免责协议确认 · ${agreementNode}`" width="620px" :close-on-click-modal="false" @opened="onAgreementOpened">
      <el-alert type="warning" :closable="false">本次操作须重新阅读并确认当前生效版本，历史确认不能沿用。</el-alert>
      <h3>{{ currentAgreement?.title }} · V{{ currentAgreement?.version }}</h3>
      <div ref="agreementBodyElement" class="agreement-text" style="max-height: 280px; overflow-y: auto; white-space: pre-wrap; margin: 16px 0" @scroll="onAgreementScroll">{{ currentAgreement?.body }}</div>
      <template #footer>
        <el-button @click="finishAgreement(false)">取消</el-button>
        <el-button type="primary" :disabled="!agreementReadToEnd" @click="finishAgreement(true)">我已阅读并同意</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="agreementFormVisible" title="新增免责协议版本" width="700px">
      <el-form label-position="top">
        <el-form-item label="协议标题"><el-input v-model="agreementForm.title" maxlength="50" show-word-limit /></el-form-item>
        <el-form-item label="协议正文"><el-input v-model="agreementForm.body" type="textarea" :rows="12" maxlength="5000" show-word-limit /></el-form-item>
      </el-form>
      <template #footer><el-button @click="agreementFormVisible = false">取消</el-button><el-button type="primary" @click="createAgreementVersion">提交并立即生效</el-button></template>
    </el-dialog>

    <el-dialog :model-value="agreementConfirmationVersion !== undefined" :title="`V${agreementConfirmationVersion} 确认记录`" width="820px" @close="agreementConfirmationVersion = undefined">
      <div class="actions-row">
        <el-input v-model="agreementConfirmationFilters.userId" placeholder="确认人账号" style="width: 160px" />
        <el-select v-model="agreementConfirmationFilters.node" placeholder="确认节点" style="width: 160px"><el-option label="全部节点" value="" /><el-option label="提交认购" value="提交认购" /><el-option label="查看缴款码" value="查看缴款码" /><el-option label="确认收款" value="确认收款" /></el-select>
        <el-date-picker v-model="agreementConfirmationFilters.dates" type="daterange" value-format="YYYY-MM-DD" start-placeholder="开始日期" end-placeholder="结束日期" />
        <el-button type="primary" @click="agreementConfirmationPage = 1; loadAgreementConfirmations()">查询</el-button>
      </div>
      <el-table :data="agreementConfirmations" empty-text="暂无确认记录">
        <el-table-column prop="userName" label="确认人" width="140" />
        <el-table-column prop="version" label="版本号" width="90" />
        <el-table-column prop="node" label="确认节点" width="130" />
        <el-table-column prop="relatedId" label="关联单据" min-width="180" />
        <el-table-column prop="confirmedAt" label="确认时间" width="210" />
      </el-table>
      <el-pagination v-model:current-page="agreementConfirmationPage" :page-size="10" :total="agreementConfirmationTotal" layout="total, prev, pager, next" />
    </el-dialog>

    <el-dialog v-model="subscribeVisible" title="确认认购" width="520px">
      <dl class="desc">
        <dt>项目</dt><dd>{{ selectedProject.title }}</dd>
        <template v-if="selectedProjectShareRule"><dt>认购份数</dt><dd>{{ subscribeShares }} 份</dd></template>
        <dt>认购金额</dt><dd>{{ formatMoney(effectiveSubscribeAmount) }}</dd>
        <template v-if="selectedProjectShareRule"><dt>预计利润</dt><dd>{{ selectedShareEstimatedProfit === null ? '暂无估算' : formatMoney(selectedShareEstimatedProfit) }}（仅供参考）</dd></template>
        <dt>协议状态</dt><dd>已确认当前有效版本</dd>
      </dl>
      <el-alert
        class="subscribe-deadline-alert"
        type="warning"
        :closable="false"
      >
        提醒：认购后需12h内缴款完结，否则自动释放已认购未缴款的认购单
      </el-alert>
      <template #footer>
        <el-button @click="subscribeVisible = false">再想想</el-button>
        <el-button type="primary" @click="confirmSubscribe">确认提交</el-button>
      </template>
    </el-dialog>

    <el-drawer v-model="auditVisible" title="结构化差异（before / after）" size="480px">
      <div class="diff">
        <p>{{ selectedAudit?.action }} · {{ selectedAudit?.target }}</p>
        <p v-if="selectedAudit?.requestId">请求编号：{{ selectedAudit.requestId }}</p>
        <h4>变更前</h4>
        <pre>{{ formatAuditValue(selectedAudit?.before) }}</pre>
        <h4>变更后</h4>
        <pre>{{ formatAuditValue(selectedAudit?.after) }}</pre>
      </div>
    </el-drawer>

    <el-dialog v-model="receivingCodeCreateVisible" title="创建收款码" width="620px">
      <el-form label-width="120px">
        <el-form-item label="收款主体" required>
          <el-input v-model="receivingCodeForm.subject" placeholder="请输入收款主体" />
        </el-form-item>
        <el-form-item label="账户说明" required>
          <el-input v-model="receivingCodeForm.accountNote" placeholder="例如：支付宝收款码 · 财务专用" />
        </el-form-item>
        <el-form-item label="收款码名称" required>
          <el-input v-model="receivingCodeForm.codeName" placeholder="例如：支付宝收款码" />
        </el-form-item>
        <el-form-item label="收款码">
          <el-upload
            ref="receivingCodeUploadRef"
            drag
            action="#"
            accept="image/*"
            :auto-upload="false"
            :show-file-list="false"
            @change="handleReceivingCodeImageChange"
          >
            <el-icon><Upload /></el-icon>
            <div>{{ receivingCodeImageUrl ? '重新选择收款码图片' : '上传收款码图片' }}</div>
          </el-upload>
          <div v-if="receivingCodeImageUrl" class="receiving-code-upload-preview">
            <el-image
              :src="receivingCodeImageUrl"
              :preview-src-list="[receivingCodeImageUrl]"
              preview-teleported
              fit="contain"
            />
            <div>
              <span>已上传收款码图片，点击图片可查看大图</span>
              <el-button link type="danger" @click="removeReceivingCodeImage">移除图片</el-button>
            </div>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button :disabled="receivingCodeSubmitting" @click="receivingCodeCreateVisible = false">取消</el-button>
        <el-button type="primary" :loading="receivingCodeSubmitting" @click="createReceivingCode">
          {{ receivingCodeSubmitting ? '创建中…' : '创建' }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="receivingCodeImageVisible" title="上传或更换收款码图片" width="620px">
      <el-alert
        title="图片保存后，收款码列表、规则配置和员工支付页会展示同一张实际图片。"
        type="info"
        :closable="false"
        show-icon
        style="margin-bottom: 16px"
      />
      <el-form label-width="120px">
        <el-form-item label="收款码编号">
          <strong>{{ editingReceivingCodeId }}</strong>
        </el-form-item>
        <el-form-item label="选择图片" required>
          <el-upload
            ref="receivingCodeImageUploadRef"
            drag
            action="#"
            accept="image/png,image/jpeg,image/webp"
            :auto-upload="false"
            :show-file-list="false"
            @change="handleExistingReceivingCodeImageChange"
          >
            <el-icon><Upload /></el-icon>
            <div>{{ editingReceivingCodeImageUrl ? '重新选择真实收款码图片' : '选择真实收款码图片' }}</div>
            <template #tip><div class="el-upload__tip">仅支持 PNG、JPG/JPEG、WebP，且不超过 5MB</div></template>
          </el-upload>
          <div v-if="editingReceivingCodeImageUrl" class="receiving-code-upload-preview">
            <el-image
              :src="editingReceivingCodeImageUrl"
              :preview-src-list="[editingReceivingCodeImageUrl]"
              preview-teleported
              fit="contain"
            />
            <span>{{ editingReceivingCodeImageName }}，点击图片可放大预览</span>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="receivingCodeImageVisible = false">取消</el-button>
        <el-button type="primary" @click="saveReceivingCodeImage">保存图片</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="ruleCreateVisible" :title="ruleDialogTitle" width="720px">
      <el-form label-width="150px" :disabled="ruleReadonly">
        <el-form-item label="所属项目" required>
          <el-select v-model="ruleForm.projectId" filterable placeholder="请选择尚未配置认购规则的项目" style="width: 100%">
            <el-option
              v-for="project in projects"
              :key="project.id"
              :label="project.title"
              :value="project.id"
              :disabled="isRuleProjectOptionDisabled(project.id)"
            />
          </el-select>
        </el-form-item>
        <el-form-item v-if="selectedRuleProject" label="项目金额">
          <div class="rule-project-amounts">
            <span>项目成本金额：<strong>{{ formatMoney(projectCostAmount(selectedRuleProject)) }}</strong></span>
            <span>项目销售金额：<strong>{{ formatMoney(projectSalesAmount(selectedRuleProject)) }}</strong></span>
          </div>
        </el-form-item>
        <el-form-item label="项目收款码" required>
          <el-select v-model="ruleForm.receivingCodeId" placeholder="请选择项目收款码" style="width: 100%">
            <el-option
              v-for="code in enabledReceivingCodes"
              :key="code.id"
              :label="`${code.codeName} / ${code.subject} / ${code.accountNote}`"
              :value="code.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item v-if="selectedRuleReceivingCode" label="收款码预览">
          <section class="rule-receiving-preview">
            <el-image
              v-if="selectedRuleReceivingCode.imageUrl"
              class="code-thumb code-thumb--image rule-receiving-preview__qr"
              :src="selectedRuleReceivingCode.imageUrl"
              :preview-src-list="[selectedRuleReceivingCode.imageUrl]"
              preview-teleported
              fit="contain"
            />
            <div v-else class="code-thumb rule-receiving-preview__qr"><Grid /></div>
            <div class="rule-receiving-preview__meta">
              <strong>{{ selectedRuleReceivingCode.codeName }}</strong>
              <span>收款主体：{{ selectedRuleReceivingCode.subject }}</span>
              <span>账户说明：{{ selectedRuleReceivingCode.accountNote }}</span>
              <span>收款码编号：{{ selectedRuleReceivingCode.id }}</span>
            </div>
          </section>
        </el-form-item>
        <el-form-item label="规则名称" required>
          <el-input v-model="ruleForm.ruleName" placeholder="例如：办公设备集采补充认购规则" />
        </el-form-item>
        <el-form-item label="开放认购时间" required>
          <el-date-picker
            v-model="ruleTimeRange"
            type="datetimerange"
            start-placeholder="开始时间"
            end-placeholder="截止时间"
            range-separator="至"
            format="YYYY-MM-DD HH:mm"
            value-format="YYYY-MM-DD HH:mm"
            class="rule-time-range"
          />
        </el-form-item>
        <el-form-item v-if="isShareRuleForm" label="缴款截止时间" required>
          <el-date-picker v-model="ruleForm.paymentCutoffAt" type="datetime" format="YYYY-MM-DD HH:mm" value-format="YYYY-MM-DD HH:mm" placeholder="选择缴款截止时间" />
        </el-form-item>
        <el-form-item v-if="isShareRuleForm" label="计划付款日" required>
          <el-date-picker v-model="ruleForm.plannedPaymentDate" type="date" format="YYYY-MM-DD" value-format="YYYY-MM-DD" placeholder="选择计划付款日" />
        </el-form-item>
        <el-form-item v-if="isShareRuleForm" label="每份金额" required>
          <el-input-number v-model="ruleForm.sharePrice" :min="0.01" :precision="2" :step="100" controls-position="right" />
          <span class="form-unit">元/份</span>
        </el-form-item>
        <el-form-item v-if="isShareRuleForm" label="公司前置认购份数" required>
          <el-input-number v-model="ruleForm.companyFrontShares" :min="0" :precision="0" controls-position="right" />
        </el-form-item>
        <el-form-item v-if="isShareRuleForm" label="员工个人认购上限">
          <el-input-number v-model="ruleForm.maxSharesPerEmployee" :min="1" :precision="0" controls-position="right" />
          <span class="form-unit">不填则不单独限制</span>
        </el-form-item>
        <el-form-item v-if="!isShareRuleForm" label="公司固定认购金额" required>
          <el-input-number v-model="ruleForm.companyFixedAmount" :min="0" :step="1000" controls-position="right" />
          <span class="form-unit">元</span>
        </el-form-item>
        <el-form-item v-if="isShareRuleForm" label="份额合计">
          <div class="derived-field">采购成本 {{ formatMoney(selectedRuleProject ? projectCostAmount(selectedRuleProject) : 0) }}；公司前置金额 {{ formatMoney((ruleForm.sharePrice ?? 0) * (ruleForm.companyFrontShares ?? 0)) }}</div>
        </el-form-item>
        <el-form-item label="开放认购金额" required>
          <div class="derived-field">
            <strong>{{ formatMoney(derivedRuleTotalAmount) }}</strong>
            <span>项目成本金额 - 公司固定认购金额</span>
          </div>
        </el-form-item>
        <el-form-item v-if="!isShareRuleForm" label="开放参与人数" required>
          <el-input-number v-model="ruleForm.minParticipants" :min="1" controls-position="right" />
        </el-form-item>
        <el-form-item v-if="!isShareRuleForm" label="单次认购最低金额" required>
          <div class="derived-field">
            <strong>{{ formatMoney(derivedRuleMinAmount) }}</strong>
            <span>开放认购金额 / 开放参与人数</span>
          </div>
        </el-form-item>
        <el-form-item label="是否允许多次认购">
          <el-switch v-model="ruleForm.allowMultiple" />
        </el-form-item>
        <el-form-item v-if="!isShareRuleForm" label="截止后公司兜底">
          <el-switch v-model="ruleForm.companyTakeover" />
        </el-form-item>
        <el-form-item v-else label="公司自动兜底">
          <span>所有员工认购单的 12 小时缴款期限结束后，自动承接未认满份额；公司出资仍需财务确认。</span>
        </el-form-item>
        <el-form-item label="发布状态" required>
          <el-radio-group v-model="ruleForm.status">
            <el-radio-button label="未启用" />
            <el-radio-button label="已启用" />
            <el-radio-button label="已停用" />
          </el-radio-group>
        </el-form-item>
      </el-form>
      <el-alert
        v-if="ruleReadonly || ruleFormLockedBySubscriptions"
        type="warning"
        :closable="false"
        class="mb12"
      >
        该规则已被有真实认购记录的项目使用，当前仅支持查看详情，不支持修改规则配置内容；如需停止，请执行“关闭众筹单”并跟踪逐笔退款。
      </el-alert>
      <template #footer>
        <el-button @click="ruleCreateVisible = false">{{ ruleReadonly ? '关闭' : '取消' }}</el-button>
        <el-button
          v-if="!ruleReadonly"
          type="primary"
          :disabled="ruleFormLockedBySubscriptions"
          @click="submitRule"
        >
          {{ editingRuleId ? '保存修改' : '保存规则' }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="openProjectVisible" title="开放项目认购" width="680px">
      <el-form label-width="150px">
        <el-form-item label="项目名称">
          <el-input :model-value="openProjectTitle" disabled />
        </el-form-item>
        <el-form-item label="认购规则">
          <el-input
            :model-value="selectedOpenRule ? `${selectedOpenRule.ruleName} / ${selectedOpenRule.projectName} / ${selectedOpenRule.status}` : '-'"
            disabled
          />
        </el-form-item>
        <el-alert type="info" :closable="false" class="mb12">
          当前规则仅用于开放前查看，不支持在此弹窗内选择或切换认购规则；确认开放后，项目将使用当前规则的开放认购金额和截止时间。
        </el-alert>
        <section v-if="selectedOpenRule" class="rule-summary">
          <div><span>规则编号</span><strong>{{ selectedOpenRule.id }}</strong></div>
          <div><span>开放认购金额</span><strong>{{ formatMoney(selectedOpenRule.totalAmount) }}</strong></div>
          <div><span>单次认购最低金额</span><strong>{{ formatMoney(selectedOpenRule.minAmount) }}</strong></div>
          <div><span>开放参与人数</span><strong>{{ selectedOpenRule.minParticipants }} 人</strong></div>
          <div><span>开放时间</span><strong>{{ selectedOpenRule.startAt || '-' }}</strong></div>
          <div><span>截止时间</span><strong>{{ selectedOpenRule.endAt || '-' }}</strong></div>
          <div><span>允许多次认购</span><strong>{{ selectedOpenRule.allowMultiple ? '允许' : '不允许' }}</strong></div>
          <div><span>截止后公司兜底</span><strong>{{ selectedOpenRule.companyTakeover ? '启用' : '不启用' }}</strong></div>
        </section>
      </el-form>
      <template #footer>
        <el-button @click="openProjectVisible = false">取消</el-button>
        <el-button type="primary" :disabled="!selectedOpenRuleId" @click="submitOpenProject">确认开放</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="interruptVisible" title="中断项目认购" width="620px">
      <el-alert type="warning" :closable="false" class="mb12">
        已发布众筹单请使用“关闭众筹单”及项目退款流程。
      </el-alert>
      <el-form label-width="120px">
        <el-form-item label="项目名称">
          <el-input :model-value="interruptProjectTitle" disabled />
        </el-form-item>
        <el-form-item label="中断原因">
          <el-input
            v-model="interruptReason"
            type="textarea"
            :rows="4"
            placeholder="请填写中断原因，例如：上游采购项目取消、金额口径调整、收款账户异常等"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="interruptVisible = false">取消</el-button>
        <el-button type="danger" :disabled="!interruptReason.trim()" @click="submitInterrupt">确认中断</el-button>
      </template>
    </el-dialog>

    <el-drawer v-model="ruleDrawerVisible" title="认购规则配置 · 数据中心 UPS 电池更换" size="520px">
      <el-form label-position="top">
        <el-form-item label="认购金额"><el-input value="120000.00"><template #append>元</template></el-input></el-form-item>
        <el-form-item label="截止时间"><el-date-picker type="datetime" placeholder="选择截止时间" /></el-form-item>
        <el-form-item label="开放参与人数"><el-input-number :model-value="20" /></el-form-item>
        <el-form-item><el-button type="primary" @click="ruleDrawerVisible = false">保存并发布</el-button></el-form-item>
      </el-form>
    </el-drawer>
  </div>
</template>
