export type Notification = {
  id: string
  recipientId: string
  type: string
  title: string
  content: string
  targetPage: string
  projectId?: string
  subscriptionId?: string
  createdAt: string
  readAt?: string
}

export function recipientNotification(input: {
  type: string; sourceId: string; recipientId: string; content: string;
  targetPage: string; projectId?: string; subscriptionId?: string; createdAt: string
}): Notification {
  return { ...input, id: `${input.type}:${input.sourceId}:${input.recipientId}`, title: input.type }
}

export function paymentReminderDue(input: {
  paymentDeadlineAt: string
  paymentReminderHours: number
  pay: string
}, at: Date): boolean {
  if (!['未缴款', '复核驳回'].includes(input.pay)) return false
  const deadline = Date.parse(input.paymentDeadlineAt.replace(' ', 'T') + '+08:00')
  const remaining = deadline - at.getTime()
  return Number.isFinite(deadline) && remaining > 0
    && remaining <= input.paymentReminderHours * 60 * 60 * 1000
}

export function subscriptionNotification(input: {
  id: string; projectId?: string; userId?: string; paymentDeadlineAt: string
}, type: '认购成功' | '缴款即将截止' | '缴款已逾期', createdAt: string): Notification | null {
  if (!input.userId) return null
  return {
    id: `${type}:${input.id}:${input.userId}`,
    recipientId: input.userId,
    type,
    title: type,
    content: type === '认购成功'
      ? `您已成功认购众筹单【${input.projectId ?? ''}】，请在【${input.paymentDeadlineAt}】前完成缴款`
      : type === '缴款已逾期'
        ? `您的认购单【${input.id}】已超过缴款截止时间，已作废`
        : `您的认购单【${input.id}】将于【${input.paymentDeadlineAt}】截止缴款，请尽快处理`,
    targetPage: 'mine', projectId: input.projectId, subscriptionId: input.id, createdAt
  }
}
