export type ProjectRefundProxyRequest = {
  id: string
  projectId: string
  refundId: string
  subscriptionId: string
  participantId: string
  reason: string
  accountDisabled: boolean
  offlineVerificationNote?: string
  proofAssetIds: string[]
  status: '待公司复核' | '已通过' | '已驳回'
  requestedBy: string
  requestedAt: string
  reviewedBy?: string
  reviewedAt?: string
  reviewReason?: string
}

export function validateProjectRefundProxy(input: {
  reason: string; accountDisabled: boolean; offlineVerificationNote?: string;
  paidAt: string; proofAssetIds: string[]; confirmDays: number
}, now: Date) {
  const reason = input.reason.trim()
  if (reason.length < 5 || reason.length > 200) throw new Error('代确认原因须为 5 至 200 字')
  if (!Number.isInteger(input.confirmDays) || input.confirmDays < 1 || input.confirmDays > 90) {
    throw new Error('代确认超期天数配置无效')
  }
  const paidAt = Date.parse(input.paidAt)
  if (!Number.isFinite(paidAt) || paidAt + input.confirmDays * 24 * 60 * 60 * 1000 > now.getTime()) {
    throw new Error('未超过代确认超期天数，暂不可申请代确认')
  }
  if (!input.proofAssetIds.length) throw new Error('原退款凭证缺失，不能申请代确认')
  const offlineVerificationNote = input.offlineVerificationNote?.trim() ?? ''
  if (input.accountDisabled && (offlineVerificationNote.length < 5 || offlineVerificationNote.length > 200)) {
    throw new Error('员工账号停用时须填写 5 至 200 字线下核实收款对象记录')
  }
  return { reason, accountDisabled: input.accountDisabled,
    ...(input.accountDisabled ? { offlineVerificationNote } : {}) }
}
