export type SettlementInvoiceRecord = {
  id: string
  amount: number
  fileName: string
  assetId: string
  transactionDate: string
  payer: string
  payee: string
  confirmedAt: string
  operator: string
  resultStatus: '凭证已确认' | '部分已结算' | '已完结'
  settledAmountAfter: number
  remainingAmountAfter: number
}

export type SettlementProjectState = {
  id: string
  status: string
  statusType: string
  salesAmount: number
  settledAmount?: number
  settlementInvoices?: SettlementInvoiceRecord[]
}

export type SettlementConfirmationInput = {
  idempotencyKey: string
  amount: number
  fileName: string
  assetId: string
  transactionDate: string
  payer: string
  payee: string
  operator: string
}

function money(value: number) {
  return Number(value.toFixed(2))
}

export function confirmProjectSettlement(
  project: SettlementProjectState,
  input: SettlementConfirmationInput,
  confirmedAt: string
) {
  const settlementInvoices = project.settlementInvoices ?? []
  const settledAmount = money(Number(project.settledAmount) || 0)
  const remainingAmount = money(Math.max(0, project.salesAmount - settledAmount))
  const duplicate = settlementInvoices.find(invoice => invoice.id === input.idempotencyKey)
  if (duplicate) {
    return {
      duplicate: true,
      settledAmount,
      remainingAmount,
      canUploadMore: remainingAmount > 0,
      invoice: duplicate
    }
  }
  if (project.status === '已完结') throw new Error('历史项目状态待核实，不能继续上传凭证')
  if (remainingAmount <= 0) throw new Error('发票凭证金额已达到预计销售额，不能继续上传')
  if (!['已满额', '已截止', '部分已结算'].includes(project.status)) throw new Error('项目当前状态不允许确认结算')
  if (!input.idempotencyKey.trim()) throw new Error('结算幂等键不能为空')
  if (!Number.isFinite(input.amount) || input.amount <= 0) throw new Error('交易金额必须大于 0')
  if (!Number.isSafeInteger(Math.round(input.amount * 100)) || Math.abs(input.amount * 100 - Math.round(input.amount * 100)) > 0.000001) {
    throw new Error('交易金额须精确到分')
  }
  const amount = money(input.amount)
  if (amount < 0.01) throw new Error('交易金额不能低于 0.01 元')
  if (amount > remainingAmount) throw new Error('交易金额超过项目剩余待结算金额')

  const nextSettledAmount = money(settledAmount + amount)
  const nextRemainingAmount = money(Math.max(0, project.salesAmount - nextSettledAmount))
  const invoice: SettlementInvoiceRecord = {
    id: input.idempotencyKey,
    amount,
    fileName: input.fileName,
    assetId: input.assetId,
    transactionDate: input.transactionDate,
    payer: input.payer,
    payee: input.payee,
    confirmedAt,
    operator: input.operator,
    resultStatus: '凭证已确认',
    settledAmountAfter: nextSettledAmount,
    remainingAmountAfter: nextRemainingAmount
  }
  settlementInvoices.push(invoice)
  project.settlementInvoices = settlementInvoices
  project.settledAmount = nextSettledAmount
  return {
    duplicate: false,
    settledAmount: project.settledAmount,
    remainingAmount: nextRemainingAmount,
    canUploadMore: nextRemainingAmount > 0,
    invoice
  }
}
