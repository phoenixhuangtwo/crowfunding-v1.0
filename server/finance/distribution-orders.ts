import { calculateDistribution, type Distribution } from './distribution.ts'

export type DistributionOrderStatus = '待审批' | '已驳回' | '已作废' | '已审批' | '打款登记中' | '待员工确认' | '有异议' | '可结单' | '已完成'
export type DistributionOrder = {
  id: string
  projectId: string
  status: DistributionOrderStatus
  receivableCents: number
  procurementPaymentCents: number
  customerReceiptsCents: number
  companyTopUpsCents: number
  companyReturnsCents: number
  confirmedCostsCents: number
  profitCents: number
  companyRoundingResidualCents: number
  payoutTotalCents: number
  lines: Array<Distribution['lines'][number] & { status: '待登记打款' | '待员工确认' | '已确认' | '有异议' }>
  generatedBy: string
  createdAt: string
  approvedBy?: string
  approvedAt?: string
  rejectedBy?: string
  rejectedAt?: string
  rejectReason?: string
  voidedBy?: string
  voidedAt?: string
}

export function distributionOrderIsActive(order: DistributionOrder) {
  return order.status !== '已驳回' && order.status !== '已作废'
}

export function makeDistributionOrder(input: Parameters<typeof calculateDistribution>[0] & {
  id: string; projectId: string; generatedBy: string; createdAt: string
}): DistributionOrder {
  const distribution = calculateDistribution(input)
  if (distribution.distributableCents !== input.receivableCents) throw new Error('回款尚未足额，不能生成分配单')
  const payoutTotalCents = distribution.lines.reduce((sum, line) => sum + line.payoutCents, 0)
  if (!Number.isSafeInteger(payoutTotalCents)
    || payoutTotalCents !== input.receivableCents - input.confirmedCostsCents) {
    throw new Error('分配所得与应收扣除已确认成本后的金额不一致')
  }
  return {
    id: input.id, projectId: input.projectId, status: '待审批',
    receivableCents: input.receivableCents,
    procurementPaymentCents: input.procurementPaymentsCents,
    customerReceiptsCents: input.customerReceiptsCents,
    companyTopUpsCents: input.companyTopUpsCents,
    companyReturnsCents: input.companyReturnsCents,
    confirmedCostsCents: input.confirmedCostsCents,
    profitCents: distribution.profitCents,
    companyRoundingResidualCents: distribution.companyRoundingResidualCents,
    payoutTotalCents,
    lines: distribution.lines.map(line => ({ ...line, status: '待登记打款' })),
    generatedBy: input.generatedBy, createdAt: input.createdAt
  }
}
