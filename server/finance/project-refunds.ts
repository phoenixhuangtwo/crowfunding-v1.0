export type ProjectRefund = {
  id: string
  projectId: string
  subscriptionId: string
  participantId: string
  amountCents: number
  reason: '众筹关闭退款' | '采购失败退款'
  status: '待退款' | '待员工确认' | '已退款'
  createdAt: string
  transactionNo?: string
  paidAt?: string
  proofAssetIds?: string[]
  manualVerificationNote?: string
  registeredBy?: string
  confirmedAt?: string
}

export function validateProjectRefundPayment(input: {
  amountCents: number; transactionNo: string; paidAt: string; proofAssetIds: string[];
  manualVerificationNote: string
}, expectedCents: number, now: Date) {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents !== expectedCents) {
    throw new RangeError('退款金额须等于已生效缴款金额')
  }
  const transactionNo = input.transactionNo.trim()
  if (transactionNo.length < 6 || transactionNo.length > 64) throw new Error('退款流水号须为 6 至 64 字')
  const paidAt = Date.parse(input.paidAt)
  if (!Number.isFinite(paidAt) || paidAt > now.getTime()) throw new Error('退款时间无效或晚于当前时间')
  if (!Array.isArray(input.proofAssetIds) || input.proofAssetIds.length < 1 || input.proofAssetIds.length > 5
    || input.proofAssetIds.some(id => !id.trim()) || new Set(input.proofAssetIds).size !== input.proofAssetIds.length) {
    throw new Error('退款凭证须提供 1 至 5 张不同的图片')
  }
  const manualVerificationNote = input.manualVerificationNote.trim()
  if (manualVerificationNote.length < 5 || manualVerificationNote.length > 200) {
    throw new Error('请填写 5 至 200 字退款凭证人工核验说明')
  }
  return { amountCents: expectedCents, transactionNo, paidAt: new Date(paidAt).toISOString(),
    proofAssetIds: [...input.proofAssetIds], manualVerificationNote }
}
