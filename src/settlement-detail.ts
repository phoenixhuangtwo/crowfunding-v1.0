export type SettlementDetailRow = {
  userId?: string
  paymentSuccessAt?: string
  paymentUploadedAt?: string
}

export function settlementSubscriberLabel(row: SettlementDetailRow, names: Record<string, string>): string {
  const userId = row.userId?.trim()
  if (!userId) return '-'

  const employeeName = names[userId]
  return employeeName ? `${userId} · ${employeeName}` : userId
}

export function settlementPaymentTime(row: SettlementDetailRow): string {
  return row.paymentSuccessAt?.trim() || row.paymentUploadedAt?.trim() || '-'
}
