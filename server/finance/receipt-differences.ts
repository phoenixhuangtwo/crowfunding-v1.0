export type ReceiptDifference = {
  id: string
  projectId: string
  amountCents: number
  destination: '退回客户' | '计入公司'
  reason: string
  refundTransactionNo?: string
  registeredBy: string
  createdAt: string
}

export function unresolvedReceiptDifference(excessCents: number, existing: ReceiptDifference[]) {
  if (!Number.isSafeInteger(excessCents) || excessCents < 0) throw new RangeError('超额差异金额无效')
  const handled = existing.reduce((sum, record) => sum + BigInt(record.amountCents), 0n)
  if (handled > BigInt(excessCents)) throw new RangeError('已登记差异超过实际超额回款，请核对')
  return { handledCents: Number(handled), unresolvedCents: excessCents - Number(handled) }
}

export function validateReceiptDifference(input: Omit<ReceiptDifference, 'createdAt'>,
  excessCents: number, existing: ReceiptDifference[], now: Date): ReceiptDifference {
  if (!input.id.trim() || !input.projectId.trim() || !input.registeredBy.trim()) throw new Error('差异登记信息不完整')
  if (input.destination !== '退回客户' && input.destination !== '计入公司') throw new Error('差异去向无效')
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new RangeError('登记金额须为大于零的整数分')
  const unresolved = unresolvedReceiptDifference(excessCents, existing)
  if (input.amountCents > unresolved.unresolvedCents) throw new RangeError('登记金额超过待处理差异')
  const reason = input.reason.trim()
  if (reason.length < 5 || reason.length > 200) throw new Error('差异说明须为 5 至 200 字')
  const refundTransactionNo = input.refundTransactionNo?.trim()
  if (input.destination === '退回客户' && (!refundTransactionNo || refundTransactionNo.length < 6 || refundTransactionNo.length > 64)) {
    throw new Error('退回客户须填写 6 至 64 字退款流水号')
  }
  if (input.destination === '计入公司' && refundTransactionNo) throw new Error('计入公司不得填写退款流水号')
  return { ...input, reason, ...(refundTransactionNo ? { refundTransactionNo } : {}), createdAt: now.toISOString() }
}
