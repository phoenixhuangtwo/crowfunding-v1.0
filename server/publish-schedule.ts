const shanghai = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
})

function dateTime(value: unknown, name: string) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(value)) {
    throw new RangeError(`${name}格式无效`)
  }
  const normalized = value.replace('T', ' ')
  const stamp = Date.parse(`${normalized.replace(' ', 'T')}${normalized.length === 16 ? ':00' : ''}+08:00`)
  if (!Number.isFinite(stamp) || formatShanghai(stamp).slice(0, normalized.length) !== normalized) {
    throw new RangeError(`${name}格式无效`)
  }
  return stamp
}

function formatShanghai(stamp: number) {
  const parts = shanghai.formatToParts(new Date(stamp))
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? ''
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`
}

export function validatePublishSchedule(input: {
  subscriptionCutoffAt: unknown
  paymentCutoffAt: unknown
  plannedPaymentDate: unknown
}, at = Date.now()) {
  const subscriptionCutoff = dateTime(input.subscriptionCutoffAt, '认购截止时间')
  const paymentCutoff = dateTime(input.paymentCutoffAt, '缴款截止时间')
  if (typeof input.plannedPaymentDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.plannedPaymentDate)) {
    throw new RangeError('计划付款日格式无效')
  }
  const plannedPayment = dateTime(`${input.plannedPaymentDate} 00:00`, '计划付款日')
  if (subscriptionCutoff <= at) throw new RangeError('认购截止时间须晚于当前时间')
  if (paymentCutoff <= subscriptionCutoff || plannedPayment <= paymentCutoff) {
    throw new RangeError('缴款截止时间须晚于认购截止时间且早于计划付款日')
  }
  return { subscriptionCutoff, paymentCutoff, plannedPayment }
}

export function employeePaymentDeadline(createdAt: string, paymentCutoffAt: string, paymentHours = 12) {
  if (!Number.isSafeInteger(paymentHours) || paymentHours < 1) throw new RangeError('缴款时限无效')
  const created = dateTime(createdAt, '认购提交时间')
  const cutoff = dateTime(paymentCutoffAt, '缴款截止时间')
  return formatShanghai(Math.min(created + paymentHours * 60 * 60 * 1000, cutoff))
}
