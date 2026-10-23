function cents(value: number, name: string) {
  if (!Number.isFinite(value) || value <= 0 || !Number.isSafeInteger(Math.round(value * 100)) || Math.abs(value * 100 - Math.round(value * 100)) > 0.000001) {
    throw new RangeError(`${name} 必须是大于 0 且最多两位小数的金额`)
  }
  return Math.round(value * 100)
}

export function prepareShareRule(costAmount: number, sharePrice: number, companyFrontShares: number, maxSharesPerEmployee: number) {
  const costCents = cents(costAmount, '采购成本')
  const shareCents = cents(sharePrice, '每份金额')
  if (costCents % shareCents !== 0) throw new RangeError('采购成本必须能被每份金额整除')
  const totalShares = costCents / shareCents
  if (!Number.isSafeInteger(companyFrontShares) || companyFrontShares < 0 || companyFrontShares >= totalShares) {
    throw new RangeError('公司前置份数必须是小于总份数的非负整数')
  }
  const employeeShares = totalShares - companyFrontShares
  if (!Number.isSafeInteger(maxSharesPerEmployee) || maxSharesPerEmployee < 1 || maxSharesPerEmployee > employeeShares) {
    throw new RangeError('员工个人上限必须在 1 份到员工可认购份数之间')
  }
  return {
    sharePrice: shareCents / 100,
    totalShares,
    companyFrontShares,
    maxSharesPerEmployee,
    companyFixedAmount: companyFrontShares * shareCents / 100,
    totalAmount: employeeShares * shareCents / 100
  }
}

export function calculateShareSubscription(sharePrice: number, requestedShares: number, remainingAmount: number, alreadyHeldShares: number, maxSharesPerEmployee: number) {
  const shareCents = cents(sharePrice, '每份金额')
  if (!Number.isSafeInteger(requestedShares) || requestedShares < 1) throw new RangeError('认购份数必须是正整数')
  if (!Number.isSafeInteger(alreadyHeldShares) || alreadyHeldShares < 0) throw new RangeError('已有份数无效')
  if (!Number.isSafeInteger(maxSharesPerEmployee) || maxSharesPerEmployee < 1 || requestedShares + alreadyHeldShares > maxSharesPerEmployee) {
    throw new RangeError('认购份数超过员工个人上限')
  }
  const amountCents = requestedShares * shareCents
  if (!Number.isSafeInteger(amountCents) || amountCents > Math.round(remainingAmount * 100)) throw new RangeError('剩余可认购份数不足')
  return amountCents / 100
}
