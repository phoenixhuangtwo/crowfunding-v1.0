export type MappedProcurementProject = {
  id: string
  title: string
  source: string
  projectOwner: string
  status: '未开放'
  statusType: 'info'
  progress: number
  remain: number
  deadline: string
  total: number
  costAmount: number
  salesAmount: number
  profitAmount: number
  companyFixedAmount: number
  companyTakeoverAmount: number
  companyForcedTakeoverAmount: number
  employeeSubscribedAmount: number
  subscribed: number
  people: number
}

export type ProcurementOrderDetail = {
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

function centsToYuan(value: unknown) {
  const cents = Number(value)
  return Number.isFinite(cents) ? Number((cents / 100).toFixed(2)) : 0
}

function textValue(value: unknown) {
  const text = String(value ?? '').trim()
  return text || '-'
}

export function mapProcurementOrderToDetail(order: Record<string, unknown>): ProcurementOrderDetail {
  return {
    id: textValue(order.id),
    projectName: textValue(order.projectName),
    sellOrder: textValue(order.sellOrder),
    purchasingName: textValue(order.purchasingName),
    purchasingStatus: textValue(order.purchasingStatus),
    projectType: textValue(order.projectType),
    purchasingType: textValue(order.purchasingType),
    purchaseQuantity: Number(order.purchaseQuantity) || 0,
    totalCostPrice: centsToYuan(order.totalCostPrice),
    totalSellingPrice: centsToYuan(order.totalSellingPrice),
    totalTransactionPrice: centsToYuan(order.totalTransactionPrice),
    responsiblePerson: textValue(order.responsiblePerson),
    purchasingTime: textValue(order.purchasingTime),
    deliveryRequirements: textValue(order.deliveryRequirements),
    designRequirements: textValue(order.designRequirements),
    remark: textValue(order.remark),
    purchasingRemark: textValue(order.purchasingRemark)
  }
}

export function mapProcurementOrderToProject(order: Record<string, unknown>): MappedProcurementProject | null {
  const externalId = String(order.id ?? '').trim()
  const sellOrder = String(order.sellOrder ?? '').trim()
  const title = String(order.projectName ?? '').trim() || sellOrder
  const costAmount = centsToYuan(order.totalCostPrice)
  if (!externalId || !title || costAmount <= 0) return null

  const transactionAmount = centsToYuan(order.totalTransactionPrice)
  const sellingAmount = centsToYuan(order.totalSellingPrice)
  const salesAmount = transactionAmount > 0 ? transactionAmount : sellingAmount

  return {
    id: `PRJ-FSY-OFFLINE-${externalId}`,
    title,
    source: sellOrder ? `采购系统 · ${sellOrder}` : '采购系统',
    projectOwner: textValue(order.creator),
    status: '未开放',
    statusType: 'info',
    progress: 0,
    remain: costAmount,
    deadline: '',
    total: costAmount,
    costAmount,
    salesAmount,
    profitAmount: Number((salesAmount - costAmount).toFixed(2)),
    companyFixedAmount: 0,
    companyTakeoverAmount: 0,
    companyForcedTakeoverAmount: 0,
    employeeSubscribedAmount: 0,
    subscribed: 0,
    people: 0
  }
}

export function mergeProcurementProject<T extends { projectOwner?: string }>(
  existing: T,
  mapped: MappedProcurementProject,
  protectedProject: boolean
): 'updated' | 'skipped' {
  if (!protectedProject) {
    Object.assign(existing, mapped)
    return 'updated'
  }

  if (existing.projectOwner === mapped.projectOwner) return 'skipped'
  existing.projectOwner = mapped.projectOwner
  return 'updated'
}
