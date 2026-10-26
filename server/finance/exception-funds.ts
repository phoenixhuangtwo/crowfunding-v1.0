export type ExceptionFund = {
  id: string
  projectId?: string
  payerUserId?: string
  revision: number
  amountCents: number
  processedCents: number
  remainingCents: number
  transactionNo: string
  bookedAt: string
  sourceNote: string
  manualVerificationNote: string
  proofAssetIds: string[]
  status: '待处理' | '退回待确认' | '转入待复核' | '已处理'
  registeredBy: string
  createdAt: string
  allocations: Array<{ id: string; kind: '退回' | '转入认购单'; amountCents: number;
    status: '待确认' | '已完成' | '已驳回'; transactionNo?: string;
    subscriptionId?: string; reason: string; createdAt: string; reviewedBy?: string; reviewedAt?: string;
    paidAt?: string; proofAssetIds?: string[]; recipientKind?: 'employee' | 'external'; recipientUserId?: string }>
}

export function validateExceptionFund(input: Pick<ExceptionFund,
  'id' | 'projectId' | 'payerUserId' | 'amountCents' | 'transactionNo' | 'bookedAt' | 'sourceNote' | 'manualVerificationNote' | 'proofAssetIds' | 'registeredBy'>,
now: Date): ExceptionFund {
  if (!input.id.trim() || !input.registeredBy.trim()) throw new Error('异常款项登记人或编号缺失')
  if (input.payerUserId && !/^[0-9]{1,20}$/.test(input.payerUserId.trim())) throw new Error('员工付款人编号无效')
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) throw new RangeError('异常款项金额须为大于零的整数分')
  const transactionNo = input.transactionNo.trim()
  if (transactionNo.length < 6 || transactionNo.length > 64) throw new Error('异常款项流水号须为 6 至 64 字')
  const bookedAt = Date.parse(input.bookedAt)
  if (!Number.isFinite(bookedAt) || bookedAt > now.getTime()) throw new Error('异常款项到账时间无效或晚于当前时间')
  const sourceNote = input.sourceNote.trim()
  if (sourceNote.length < 5 || sourceNote.length > 200) throw new Error('异常款项来源说明须为 5 至 200 字')
  const manualVerificationNote = input.manualVerificationNote.trim()
  if (manualVerificationNote.length < 5 || manualVerificationNote.length > 200) throw new Error('无法自动识别凭证时须填写 5 至 200 字人工核验说明')
  if (!Array.isArray(input.proofAssetIds) || input.proofAssetIds.length < 1 || input.proofAssetIds.length > 5
    || input.proofAssetIds.some(id => !id.trim()) || new Set(input.proofAssetIds).size !== input.proofAssetIds.length) {
    throw new Error('异常款项凭证须提供 1 至 5 张不同的图片')
  }
  return { id: input.id, ...(input.projectId ? { projectId: input.projectId.trim() } : {}),
    ...(input.payerUserId ? { payerUserId: input.payerUserId.trim() } : {}), revision: 0,
    amountCents: input.amountCents, processedCents: 0, remainingCents: input.amountCents,
    transactionNo, bookedAt: new Date(bookedAt).toISOString(), sourceNote, manualVerificationNote,
    proofAssetIds: [...input.proofAssetIds], status: '待处理', registeredBy: input.registeredBy,
    createdAt: now.toISOString(), allocations: [] }
}

export function reserveExceptionRefund(record: ExceptionFund, input: {
  id: string; amountCents: number; transactionNo: string; paidAt: string; reason: string;
  proofAssetIds: string[]; registeredBy: string
}, now: Date): ExceptionFund {
  const pendingCents = record.allocations.filter(item => item.status === '待确认')
    .reduce((sum, item) => sum + item.amountCents, 0)
  const availableCents = record.remainingCents - pendingCents
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0 || input.amountCents > availableCents) {
    throw new RangeError(`退回金额不得大于剩余可处理金额 ${(availableCents / 100).toFixed(2)} 元`)
  }
  const transactionNo = input.transactionNo.trim()
  if (transactionNo.length < 6 || transactionNo.length > 64) throw new Error('退回流水号须为 6 至 64 字')
  const paidAt = Date.parse(input.paidAt)
  if (!Number.isFinite(paidAt) || paidAt > now.getTime()) throw new Error('实际退回时间无效或晚于当前时间')
  const reason = input.reason.trim()
  if (reason.length < 5 || reason.length > 200) throw new Error('退回说明须为 5 至 200 字')
  if (!Array.isArray(input.proofAssetIds) || input.proofAssetIds.length < 1 || input.proofAssetIds.length > 5
    || input.proofAssetIds.some(id => !id.trim()) || new Set(input.proofAssetIds).size !== input.proofAssetIds.length) {
    throw new Error('退回凭证须提供 1 至 5 张不同的图片')
  }
  return { ...record, revision: record.revision + 1, status: '退回待确认',
    allocations: [...record.allocations, { id: input.id, kind: '退回', amountCents: input.amountCents,
      status: '待确认', transactionNo, paidAt: new Date(paidAt).toISOString(), reason,
      proofAssetIds: [...input.proofAssetIds], recipientKind: record.payerUserId ? 'employee' : 'external',
      ...(record.payerUserId ? { recipientUserId: record.payerUserId } : {}), createdAt: now.toISOString() }] }
}

export function confirmExceptionRefund(record: ExceptionFund, allocationId: string,
reviewedBy: string, now: Date): ExceptionFund {
  const allocation = record.allocations.find(item => item.id === allocationId)
  if (!allocation || allocation.kind !== '退回' || allocation.status !== '待确认') throw new Error('退回单不存在或已确认')
  const allocations = record.allocations.map(item => item.id === allocationId
    ? { ...item, status: '已完成' as const, reviewedBy, reviewedAt: now.toISOString() } : item)
  const processedCents = record.processedCents + allocation.amountCents
  const remainingCents = record.amountCents - processedCents
  if (remainingCents < 0) throw new Error('异常款项已处理金额超过到账金额')
  return { ...record, revision: record.revision + 1, allocations, processedCents,
    remainingCents, status: remainingCents === 0 ? '已处理'
      : allocations.some(item => item.status === '待确认' && item.kind === '退回') ? '退回待确认' : '待处理' }
}

export function reserveExceptionTransfer(record: ExceptionFund, input: {
  id: string; subscriptionId: string; amountCents: number; reason: string
}, now: Date): ExceptionFund {
  if (!record.projectId) throw new Error('请先核实异常款项所属众筹单')
  if (!input.subscriptionId.trim()) throw new Error('请选择接收款项的认购单')
  const pendingCents = record.allocations.filter(item => item.status === '待确认')
    .reduce((sum, item) => sum + item.amountCents, 0)
  const availableCents = record.remainingCents - pendingCents
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0 || input.amountCents > availableCents) {
    throw new RangeError(`转入金额超出可转入范围，最多可转入 ${(availableCents / 100).toFixed(2)} 元`)
  }
  const reason = input.reason.trim()
  if (reason.length < 5 || reason.length > 200) throw new Error('转入说明须为 5 至 200 字')
  return { ...record, revision: record.revision + 1, status: '转入待复核',
    allocations: [...record.allocations, { id: input.id, kind: '转入认购单',
      subscriptionId: input.subscriptionId.trim(), amountCents: input.amountCents,
      status: '待确认', reason, createdAt: now.toISOString() }] }
}

export function reviewExceptionTransfer(record: ExceptionFund, allocationId: string,
decision: '通过' | '驳回', reviewedBy: string, now: Date): ExceptionFund {
  const allocation = record.allocations.find(item => item.id === allocationId)
  if (!allocation || allocation.kind !== '转入认购单' || allocation.status !== '待确认') {
    throw new Error('转入单不存在或已复核')
  }
  const allocations = record.allocations.map(item => item.id === allocationId
    ? { ...item, status: decision === '通过' ? '已完成' as const : '已驳回' as const,
      reviewedBy, reviewedAt: now.toISOString() } : item)
  const processedCents = record.processedCents + (decision === '通过' ? allocation.amountCents : 0)
  const remainingCents = record.amountCents - processedCents
  if (remainingCents < 0) throw new Error('异常款项已处理金额超过到账金额')
  const pending = allocations.find(item => item.status === '待确认')
  return { ...record, revision: record.revision + 1, allocations, processedCents,
    remainingCents, status: remainingCents === 0 ? '已处理'
      : pending?.kind === '转入认购单' ? '转入待复核'
        : pending?.kind === '退回' ? '退回待确认' : '待处理' }
}
