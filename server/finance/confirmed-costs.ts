export type ConfirmedCost = {
  id: string
  projectId: string
  amountCents: number
  transactionNo: string
  paidAt: string
  proofAssetIds: string[]
  reason: string
  status: '待公司复核' | '已确认' | '已驳回'
  registeredBy: string
  createdAt: string
  reviewedBy?: string
  reviewedAt?: string
  rejectReason?: string
}

export function validateCostRegistration(input: Omit<ConfirmedCost, 'status' | 'createdAt'>, now: Date): ConfirmedCost {
  if (!input.id.trim() || !input.projectId.trim() || !input.registeredBy.trim()) throw new Error('成本登记信息不完整')
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new RangeError('成本金额须为大于零的整数分')
  const transactionNo = input.transactionNo.trim()
  if (transactionNo.length < 6 || transactionNo.length > 64) throw new Error('成本付款流水号须为 6 至 64 字')
  const paidAt = Date.parse(input.paidAt)
  if (!Number.isFinite(paidAt) || paidAt > now.getTime()) throw new Error('成本付款时间无效或晚于当前时间')
  if (!Array.isArray(input.proofAssetIds) || input.proofAssetIds.length < 1 || input.proofAssetIds.length > 5
    || input.proofAssetIds.some(id => !id.trim()) || new Set(input.proofAssetIds).size !== input.proofAssetIds.length) {
    throw new Error('成本凭证须提供 1 至 5 张不同的图片')
  }
  const reason = input.reason.trim()
  if (reason.length < 5 || reason.length > 200) throw new Error('成本原因须为 5 至 200 字')
  return { ...input, transactionNo, paidAt: new Date(paidAt).toISOString(), reason,
    proofAssetIds: [...input.proofAssetIds], status: '待公司复核', createdAt: now.toISOString() }
}
