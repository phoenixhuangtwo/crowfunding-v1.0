export type ReceiptKind = '客户回款' | '公司补款'
export type ReceiptStatus = '待复核' | '已通过' | '已驳回'

export type ReceiptLine = { projectId: string; amountCents: number }
export type ReceiptBatch = {
  id: string
  kind: ReceiptKind
  transactionNo: string
  bookedAt: string
  totalCents: number
  lines: ReceiptLine[]
  proofAssetIds: string[]
  registeredBy: string
  reason?: string
  status: ReceiptStatus
  reviewedBy?: string
  reviewedAt?: string
  rejectReason?: string
  returns?: ReceiptLine[]
  recognitionStatus?: '凭证识别未通过' | '凭证已核对'
  note?: string
}

export type ProjectReceipts = {
  customerGrossCents: number
  companyTopUpsCents: number
  companyReturnsCents: number
  companyBalanceCents: number
  distributableCents: number
  gapCents: number
  excessCents: number
}

function cents(value: number, name: string, positive = false) {
  if (!Number.isSafeInteger(value) || value < 0 || (positive && value === 0)) {
    throw new RangeError(`${name}必须为${positive ? '大于 0 的' : '非负'}整数分`)
  }
  return value
}

function sum(values: number[], name: string) {
  const result = values.reduce((total, value) => total + BigInt(cents(value, name)), 0n)
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${name}超出安全金额范围`)
  return Number(result)
}

function lineAmount(lines: ReceiptLine[] | undefined, projectId: string) {
  return sum((lines ?? []).filter(line => line.projectId === projectId).map(line => line.amountCents), '回款金额')
}

export function summarizeProjectReceipts(batches: ReceiptBatch[], projectId: string, receivableCents: number): ProjectReceipts {
  cents(receivableCents, '应收金额', true)
  const approved = batches.filter(batch => batch.status === '已通过')
  const customerGrossCents = sum(approved.filter(batch => batch.kind === '客户回款').map(batch => lineAmount(batch.lines, projectId)), '客户回款')
  const companyTopUpsCents = sum(approved.filter(batch => batch.kind === '公司补款').map(batch => lineAmount(batch.lines, projectId)), '公司补款')
  const companyReturnsCents = sum(approved.map(batch => lineAmount(batch.returns, projectId)), '补款返还')
  if (companyReturnsCents > companyTopUpsCents) throw new RangeError('补款返还不能超过已复核公司补款')
  const companyBalanceCents = companyTopUpsCents - companyReturnsCents
  const distributableCents = sum([customerGrossCents, companyBalanceCents], '参与分配的回款')
  return {
    customerGrossCents, companyTopUpsCents, companyReturnsCents, companyBalanceCents,
    distributableCents,
    gapCents: Math.max(0, receivableCents - distributableCents),
    excessCents: Math.max(0, distributableCents - receivableCents)
  }
}

export function validateReceiptRegistration(input: {
  id: string
  kind: ReceiptKind
  transactionNo: string
  bookedAt: string
  totalCents: number
  lines: ReceiptLine[]
  proofAssetIds: string[]
  recognizedCents?: number
  recognizedTransactionNo?: string
  recognizedAt?: string
  recognitionFailed?: boolean
  note?: string
  registeredBy: string
  reason?: string
}, existing: ReceiptBatch[], receivables: Record<string, number>, now: Date, reservedTransactionNos: readonly string[] = []): ReceiptBatch {
  if (!input.id.trim() || existing.some(batch => batch.id === input.id)) throw new Error('回款登记标识已存在或为空')
  if (input.kind !== '客户回款' && input.kind !== '公司补款') throw new Error('回款类型无效')
  const transactionNo = input.transactionNo.trim()
  if (transactionNo.length < 6 || transactionNo.length > 64) throw new Error('流水号须为 6 至 64 字')
  if (reservedTransactionNos.includes(transactionNo) || existing.some(batch => batch.status !== '已驳回' && batch.transactionNo === transactionNo)) {
    throw new Error(`流水号【${transactionNo}】已被使用，请核对`)
  }
  const bookedAt = Date.parse(input.bookedAt)
  if (!Number.isFinite(bookedAt) || bookedAt > now.getTime()) throw new Error('到账时间无效或晚于当前时间')
  if (input.recognitionFailed) {
    if ((input.note?.trim().length ?? 0) < 5 || (input.note?.trim().length ?? 0) > 500) {
      throw new Error('凭证识别未通过时须填写 5 至 500 字人工核对说明')
    }
  } else if (Date.parse(input.recognizedAt ?? '') !== bookedAt) {
    throw new Error('凭证识别结果与填写内容不一致，请核对后修改或重新上传')
  }
  if (!Array.isArray(input.proofAssetIds) || input.proofAssetIds.length < 1 || input.proofAssetIds.length > 5
    || input.proofAssetIds.some(id => !id.trim()) || new Set(input.proofAssetIds).size !== input.proofAssetIds.length) {
    throw new Error('回款凭证须提供 1 至 5 张不同的已留存图片')
  }
  if (!input.registeredBy.trim()) throw new Error('登记人不能为空')
  cents(input.totalCents, '流水金额', true)
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw new Error('至少选择一个众筹单')
  const projectIds = new Set<string>()
  for (const line of input.lines) {
    if (!line.projectId.trim() || projectIds.has(line.projectId) || !(line.projectId in receivables)) throw new Error('众筹单无效或重复')
    projectIds.add(line.projectId)
    cents(line.amountCents, '本笔金额', true)
    cents(receivables[line.projectId], '应收金额', true)
  }
  if (sum(input.lines.map(line => line.amountCents), '拆分金额') !== input.totalCents) throw new Error('拆分金额合计须等于流水金额')
  if (!input.recognitionFailed && (input.recognizedCents !== input.totalCents || input.recognizedTransactionNo?.trim() !== transactionNo)) {
    throw new Error('凭证识别结果与填写内容不一致，请核对后修改或重新上传')
  }
  if (input.kind === '公司补款') {
    const reason = input.reason?.trim() ?? ''
    if (reason.length < 5 || reason.length > 200) throw new Error('补款原因须为 5 至 200 字')
    for (const line of input.lines) {
      const gap = summarizeProjectReceipts(existing, line.projectId, receivables[line.projectId]).gapCents
      const pendingTopUps = sum(existing.filter(batch => batch.kind === '公司补款' && batch.status === '待复核')
        .map(batch => lineAmount(batch.lines, line.projectId)), '待复核补款')
      if (line.amountCents > Math.max(0, gap - pendingTopUps)) throw new Error(`补款金额不得超过当前缺口 ${(Math.max(0, gap - pendingTopUps) / 100).toFixed(2)} 元`)
    }
  }
  return {
    id: input.id.trim(), kind: input.kind, transactionNo, bookedAt: new Date(bookedAt).toISOString(),
    totalCents: input.totalCents, lines: input.lines.map(line => ({ ...line })),
    proofAssetIds: [...input.proofAssetIds], registeredBy: input.registeredBy.trim(),
    ...(input.kind === '公司补款' ? { reason: input.reason!.trim() } : {}), status: '待复核',
    recognitionStatus: input.recognitionFailed ? '凭证识别未通过' : '凭证已核对',
    ...(input.recognitionFailed ? { note: input.note!.trim() } : {})
  }
}

export function reviewReceiptBatch(input: {
  batch: ReceiptBatch
  decision: '通过' | '驳回'
  reviewerId: string
  reviewerRole: 'finance' | 'company'
  actualBankCents?: number
  actualBankTransactionNo?: string
  reason?: string
  now: Date
  existing: ReceiptBatch[]
  receivables: Record<string, number>
}): ReceiptBatch {
  const { batch } = input
  if (batch.status !== '待复核') throw new Error('该回款已复核，不能重复处理')
  if (!input.reviewerId.trim()) throw new Error('复核人不能为空')
  if (batch.kind === '公司补款' && (input.reviewerRole !== 'company' || input.reviewerId === batch.registeredBy)) {
    throw new Error('公司补款须由非登记人的公司角色复核')
  }
  if (batch.kind === '客户回款' && input.reviewerRole !== 'finance') throw new Error('客户回款须由财务复核')
  if (input.decision === '驳回') {
    const reason = input.reason?.trim() ?? ''
    if (reason.length < 5 || reason.length > 200) throw new Error('驳回原因须为 5 至 200 字')
    return { ...batch, status: '已驳回', reviewedBy: input.reviewerId, reviewedAt: input.now.toISOString(), rejectReason: reason }
  }
  if (input.decision !== '通过') throw new Error('复核结果无效')
  if (input.actualBankCents !== batch.totalCents || input.actualBankTransactionNo?.trim() !== batch.transactionNo) {
    throw new Error('金额或流水号不一致，请核对后再处理')
  }
  const others = input.existing.filter(record => record.id !== batch.id)
  const returns: ReceiptLine[] = []
  for (const line of batch.lines) {
    const receivable = input.receivables[line.projectId]
    cents(receivable, '应收金额', true)
    if (batch.kind === '公司补款') {
      const gap = summarizeProjectReceipts(others, line.projectId, receivable).gapCents
      const pendingOthers = sum(others.filter(record => record.kind === '公司补款' && record.status === '待复核')
        .map(record => lineAmount(record.lines, line.projectId)), '待复核补款')
      if (line.amountCents > Math.max(0, gap - pendingOthers)) throw new Error('公司补款超过当前缺口，不能复核通过')
    } else {
      const balance = summarizeProjectReceipts(others, line.projectId, receivable).companyBalanceCents
      const returned = Math.min(balance, line.amountCents)
      if (returned > 0) returns.push({ projectId: line.projectId, amountCents: returned })
    }
  }
  return {
    ...batch, status: '已通过', reviewedBy: input.reviewerId, reviewedAt: input.now.toISOString(),
    ...(returns.length ? { returns } : {})
  }
}
