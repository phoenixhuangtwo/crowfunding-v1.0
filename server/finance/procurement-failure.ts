export type ProcurementFailureRequest = {
  id: string
  projectId: string
  reason: string
  status: '待公司复核' | '已通过' | '已驳回'
  requestedBy: string
  requestedAt: string
  reviewedBy?: string
  reviewedAt?: string
  reviewReason?: string
}

export type SupplierRefund = {
  id: string
  projectId: string
  amountCents: number
  transactionNo: string
  refundedAt: string
  proofAssetIds: string[]
  manualVerificationNote: string
  registeredBy: string
  createdAt: string
}

export function validateSupplierRefund(input: Omit<SupplierRefund, 'createdAt'>,
  procurementPaymentCents: number, alreadyRefundedCents: number, now: Date): SupplierRefund {
  const remaining = procurementPaymentCents - alreadyRefundedCents
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0 || input.amountCents > remaining) {
    throw new RangeError(`供应商退款不得大于采购付款余额 ${(Math.max(0, remaining) / 100).toFixed(2)} 元`)
  }
  const transactionNo = input.transactionNo.trim()
  if (transactionNo.length < 6 || transactionNo.length > 64) throw new Error('供应商退款流水号须为 6 至 64 字')
  const refundedAt = Date.parse(input.refundedAt)
  if (!Number.isFinite(refundedAt) || refundedAt > now.getTime()) throw new Error('供应商退款时间无效或晚于当前时间')
  if (!Array.isArray(input.proofAssetIds) || input.proofAssetIds.length < 1 || input.proofAssetIds.length > 5
    || input.proofAssetIds.some(id => !id.trim()) || new Set(input.proofAssetIds).size !== input.proofAssetIds.length) {
    throw new Error('供应商退款凭证须提供 1 至 5 张不同的图片')
  }
  const manualVerificationNote = input.manualVerificationNote.trim()
  if (manualVerificationNote.length < 5 || manualVerificationNote.length > 200) {
    throw new Error('请填写 5 至 200 字供应商退款人工核验说明')
  }
  return { ...input, transactionNo, refundedAt: new Date(refundedAt).toISOString(),
    proofAssetIds: [...input.proofAssetIds], manualVerificationNote, createdAt: now.toISOString() }
}
