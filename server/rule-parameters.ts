export type RuleParameters = {
  paymentHours: number
  paymentReminderHours: number
  proxyConfirmDays: number
  receiptWarningDays: number
  issueHandlingHours: number
}
export type StoredRuleParameters = RuleParameters & {
  id: 'global'
  revision: number
  updatedAt: string
  updatedBy: string
}
export const defaultRuleParameters: RuleParameters = Object.freeze({
  paymentHours: 12,
  paymentReminderHours: 4,
  proxyConfirmDays: 7,
  receiptWarningDays: 30,
  issueHandlingHours: 72
})
const bounds = {
  paymentHours: [1, 720],
  paymentReminderHours: [1, 168],
  proxyConfirmDays: [1, 90],
  receiptWarningDays: [1, 365],
  issueHandlingHours: [1, 720]
} as const
const labels = {
  paymentHours: '缴款时限',
  paymentReminderHours: '缴款提醒提前小时数',
  proxyConfirmDays: '代确认超期天数',
  receiptWarningDays: '回款预警天数',
  issueHandlingHours: '异议处理时限'
} as const

export function validateRuleParameters(input: Record<string, unknown>): RuleParameters {
  const output = {} as RuleParameters
  for (const key of Object.keys(bounds) as Array<keyof RuleParameters>) {
    const value = input[key]
    if (value === undefined || value === null || value === '') throw new Error(`请填写${labels[key]}`)
    const [min, max] = bounds[key]
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw new RangeError(`${labels[key]}请输入 ${min} 至 ${max} 之间的整数`)
    }
    output[key] = Number(value)
  }
  return output
}
