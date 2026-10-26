export type ReceiptOverdueCase = {
  id: string
  projectId: string
  status: '待处置' | '等待下次预警' | '已处置' | '已解除'
  gapCents: number
  warningCount: number
  lastWarnedAt: string
  action?: '继续等待' | '公司补款' | '采购失败终止'
  note?: string
  nextWarningDate?: string
  handledBy?: string
  handledAt?: string
  procurementFailureRequestId?: string
}

export function validateOverdueResolution(input: {
  action?: unknown; note?: unknown; nextWarningDate?: unknown
}, at: Date): { action: '继续等待' | '公司补款' | '采购失败终止'; note: string;
  nextWarningDate?: string } {
  const action = input.action
  if (action !== '继续等待' && action !== '公司补款' && action !== '采购失败终止') {
    throw new Error('请选择有效的回款超期处置方式')
  }
  const note = typeof input.note === 'string' ? input.note.trim() : ''
  if (note.length < 5 || note.length > 200) throw new Error('处置说明须为 5 至 200 字')
  if (action !== '继续等待') return { action, note }
  const date = input.nextWarningDate
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('请选择下次预警日期')
  }
  const time = Date.parse(`${date}T00:00:00+08:00`)
  const localToday = new Date(at.getTime() + 8 * 3_600_000).toISOString().slice(0, 10)
  if (!Number.isFinite(time) || new Date(time + 8 * 3_600_000).toISOString().slice(0, 10) !== date
    || date <= localToday) throw new Error('下次预警日期须晚于当前日期')
  return { action, note, nextWarningDate: date }
}
