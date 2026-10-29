export type ReceiptTerminationRefund = {
  id: string
  projectId: string
  receiptBatchId: string
  kind: '客户回款' | '公司补款'
  amountCents: number
  transactionNo: string
  paidAt: string
  proofAssetIds: string[]
  manualVerificationNote: string
  status: '待公司确认' | '已完成' | '已驳回'
  registeredBy: string
  createdAt: string
  reviewedBy?: string
  reviewedAt?: string
  reviewReason?: string
}

export function validateReceiptTerminationRefund(input: Omit<ReceiptTerminationRefund, 'createdAt' | 'status'>,
  availableCents: number, now: Date): ReceiptTerminationRefund {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0 || input.amountCents > availableCents) {
    throw new RangeError(`退回金额不得超过原回款可退余额 ${(Math.max(0, availableCents) / 100).toFixed(2)} 元`)
  }
  const transactionNo = input.transactionNo.trim()
  if (transactionNo.length < 6 || transactionNo.length > 64) throw new Error('退回流水号须为 6 至 64 字')
  const paidAt = Date.parse(input.paidAt)
  if (!Number.isFinite(paidAt) || paidAt > now.getTime()) throw new Error('实际退回时间无效或晚于当前时间')
  if (!Array.isArray(input.proofAssetIds) || input.proofAssetIds.length < 1 || input.proofAssetIds.length > 5
    || input.proofAssetIds.some(id => !id.trim()) || new Set(input.proofAssetIds).size !== input.proofAssetIds.length) {
    throw new Error('退回凭证须提供 1 至 5 张不同图片')
  }
  const manualVerificationNote = input.manualVerificationNote.trim()
  if (manualVerificationNote.length < 5 || manualVerificationNote.length > 200) {
    throw new Error('请填写 5 至 200 字退回人工核验说明')
  }
  return { ...input, transactionNo, paidAt: new Date(paidAt).toISOString(),
    proofAssetIds: [...input.proofAssetIds], manualVerificationNote,
    status: '待公司确认', createdAt: now.toISOString() }
}
