type Proof = { assetId?: string; recognizedAmount: number; status: '已识别' | '识别失败' }

function amountCents(amount: number, name: string) {
  const cents = Math.round(amount * 100)
  if (!Number.isFinite(amount) || amount <= 0 || !Number.isSafeInteger(cents) || Math.abs(amount * 100 - cents) > 0.000001) {
    throw new RangeError(`${name}必须是大于 0 且最多两位小数的金额`)
  }
  return cents
}

export function validateContributionReview(input: {
  expectedAmount: number
  actualPaidAmount: number
  transactionNo: string
  proofs: Proof[]
}) {
  const expectedCents = amountCents(input.expectedAmount, '认购金额')
  const actualCents = amountCents(input.actualPaidAmount, '实际到账金额')
  if (actualCents !== expectedCents) throw new RangeError('实际到账金额必须与认购金额一致')
  const transactionNo = input.transactionNo.trim()
  if (!transactionNo || transactionNo.length > 100) throw new RangeError('请输入不超过 100 字的交易流水号')
  const recognized = input.proofs.filter(proof => proof.status === '已识别')
  if (recognized.length === 0 || recognized.some(proof => !proof.assetId)) throw new RangeError('缺少已识别且已留存的缴款凭证')
  const recognizedCents = recognized.reduce((total, proof) => total + amountCents(proof.recognizedAmount, '凭证识别金额'), 0)
  if (!Number.isSafeInteger(recognizedCents) || recognizedCents !== actualCents) throw new RangeError('凭证识别金额与实际到账金额不一致')
  return { amountCents: actualCents, transactionNo, proofAssetIds: recognized.map(proof => proof.assetId!) }
}
