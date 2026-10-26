export type BackstopCandidate = {
  status: string
  sharePrice: number
  remainingAmount: number
  subscriptionCutoffAt: string
  employeePaymentDeadlines: string[]
  paymentCutoffAt?: string
  unresolvedReviewCount?: number
  companyTakeover: boolean
}

function timestamp(value: string) {
  const parsed = new Date(value.replace(' ', 'T')).getTime()
  if (!Number.isFinite(parsed)) throw new RangeError('截止时间无效')
  return parsed
}

export function paymentCutoffTime(candidate: Pick<BackstopCandidate, 'subscriptionCutoffAt' | 'employeePaymentDeadlines' | 'paymentCutoffAt'>) {
  const employeeCutoff = candidate.employeePaymentDeadlines.reduce((latest, deadline) => Math.max(latest, timestamp(deadline)), timestamp(candidate.subscriptionCutoffAt))
  return candidate.paymentCutoffAt ? Math.max(employeeCutoff, timestamp(candidate.paymentCutoffAt)) : employeeCutoff
}

/** Returns a commitment, not evidence that company funds have been paid. */
export function planCompanyBackstop(candidate: BackstopCandidate, at: Date) {
  if (!['未满额', '已满额'].includes(candidate.status) || !candidate.companyTakeover) return null
  if (candidate.unresolvedReviewCount !== undefined
    && (!Number.isSafeInteger(candidate.unresolvedReviewCount) || candidate.unresolvedReviewCount < 0)) throw new RangeError('待复核笔数无效')
  if (candidate.unresolvedReviewCount) return null
  if (at.getTime() < paymentCutoffTime(candidate)) return null
  const priceCents = Math.round(candidate.sharePrice * 100)
  const remainingCents = Math.round(candidate.remainingAmount * 100)
  if (!Number.isFinite(candidate.sharePrice) || !Number.isFinite(candidate.remainingAmount)
    || Math.abs(candidate.sharePrice * 100 - priceCents) > 0.000001
    || Math.abs(candidate.remainingAmount * 100 - remainingCents) > 0.000001
    || !Number.isSafeInteger(priceCents) || priceCents <= 0 || !Number.isSafeInteger(remainingCents) || remainingCents < 0) {
    throw new RangeError('份额金额或剩余金额无效')
  }
  if (remainingCents === 0) return null
  if (remainingCents % priceCents !== 0) throw new RangeError('剩余金额不是完整份数，不能自动兜底')
  return { shares: remainingCents / priceCents, amount: remainingCents / 100 }
}
