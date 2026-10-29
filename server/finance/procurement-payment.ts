export type ProcurementFunding = {
  purchaseCents: number
  approvedEmployeeCents: number
  companyFrontCents: number
  companyBackstopCents: number
  pendingReviewCount: number
}

export type ProcurementPaymentInput = ProcurementFunding & {
  projectId: string
  amountCents: number
  transactionNo: string
  paidAt: string
  proofAssetIds: string[]
  recognizedCents?: number
  recognizedTransactionNo?: string
  recognizedPaidAt?: string
  recognitionFailed: boolean
  companyFundsConfirmed: boolean
  note?: string
  operatorId: string
  alreadyRegistered: boolean
}

function nonNegative(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name}必须为非负整数分`)
  return value
}

export function reconcileProcurementFunding(input: ProcurementFunding) {
  const purchaseCents = nonNegative(input.purchaseCents, '采购金额')
  if (purchaseCents === 0) throw new RangeError('采购金额必须大于 0')
  const employeeCents = nonNegative(input.approvedEmployeeCents, '员工已生效缴款')
  const companyCents = nonNegative(input.companyFrontCents, '公司前置出资') + nonNegative(input.companyBackstopCents, '公司兜底出资')
  if (!Number.isSafeInteger(companyCents)) throw new RangeError('公司出资超出安全金额范围')
  if (!Number.isSafeInteger(input.pendingReviewCount) || input.pendingReviewCount < 0) throw new RangeError('待复核笔数无效')
  const differenceCents = employeeCents + companyCents - purchaseCents
  if (!Number.isSafeInteger(differenceCents)) throw new RangeError('对账差额超出安全金额范围')
  return {
    purchaseCents, employeeCents, companyCents, pendingReviewCount: input.pendingReviewCount,
    differenceCents, balanced: differenceCents === 0 && input.pendingReviewCount === 0
  }
}

export function validateProcurementPayment(input: ProcurementPaymentInput, reservedTransactionNos: readonly string[], now: Date) {
  if (!input.projectId.trim() || !input.operatorId.trim()) throw new Error('项目和登记人不能为空')
  if (input.alreadyRegistered) throw new Error('该众筹单已登记付款')
  const reconciliation = reconcileProcurementFunding(input)
  if (reconciliation.pendingReviewCount > 0) throw new Error(`存在 ${reconciliation.pendingReviewCount} 笔未复核的缴款，请先完成复核`)
  if (reconciliation.differenceCents !== 0) {
    const direction = reconciliation.differenceCents > 0 ? '高于' : '低于'
    throw new Error(`员工缴款与公司出资合计${direction}采购金额 ${(Math.abs(reconciliation.differenceCents) / 100).toFixed(2)} 元，请核对`)
  }
  if (!input.companyFundsConfirmed) throw new Error('请确认公司出资已到位')
  if (reconciliation.companyCents === 0 && !input.note?.includes('出资为零')) throw new Error('公司出资为零时请在说明中注明出资为零')
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents !== reconciliation.purchaseCents) throw new Error('付款金额须等于采购金额')
  const transactionNo = input.transactionNo.trim()
  if (transactionNo.length < 6 || transactionNo.length > 64) throw new Error('流水号须为 6 至 64 字')
  if (reservedTransactionNos.includes(transactionNo)) throw new Error(`流水号【${transactionNo}】已被使用，请核对`)
  const paidAt = Date.parse(input.paidAt)
  if (!Number.isFinite(paidAt) || paidAt > now.getTime()) throw new Error('付款时间不得晚于当前时间')
  if (!Array.isArray(input.proofAssetIds) || input.proofAssetIds.length < 1 || input.proofAssetIds.length > 5
    || input.proofAssetIds.some(id => !id.trim()) || new Set(input.proofAssetIds).size !== input.proofAssetIds.length) {
    throw new Error('请至少上传1张付款凭证，最多5张且不可重复')
  }
  if (input.recognitionFailed) {
    if (!input.note || input.note.trim().length < 5) throw new Error('凭证识别失败时须填写情况说明')
  } else if (input.recognizedCents !== input.amountCents || input.recognizedTransactionNo?.trim() !== transactionNo
    || Date.parse(input.recognizedPaidAt ?? '') !== paidAt) {
    throw new Error('凭证识别结果与填写内容不一致，请核对后修改或重新上传')
  }
  return {
    projectId: input.projectId.trim(), amountCents: input.amountCents, transactionNo,
    paidAt: new Date(paidAt).toISOString(), proofAssetIds: [...input.proofAssetIds],
    operatorId: input.operatorId.trim(), companyFundsConfirmed: true as const,
    recognitionStatus: input.recognitionFailed ? '凭证识别未通过' as const : '凭证已核对' as const,
    note: input.note?.trim() ?? ''
  }
}
