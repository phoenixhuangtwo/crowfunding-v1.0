import type { ReceiptBatch } from './finance/customer-receipts.ts'
import { summarizeProjectReceipts } from './finance/customer-receipts.ts'
import type { DistributionOrder } from './finance/distribution-orders.ts'
import { roleNotification, type Notification } from './notifications.ts'

type Project = {
  id: string; status: string; salesAmount?: number; purchasePaidAt?: string;
  ruleParametersSnapshot?: { receiptWarningDays: number; issueHandlingHours: number }
}

function timestamp(value: string | undefined) {
  if (!value) return Number.NaN
  return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}+08:00`)
}

export function planEscalationNotifications(input: {
  projects: Project[]; orders: DistributionOrder[]; receipts: ReceiptBatch[]; at: Date
}): Notification[] {
  const byProject = new Map(input.projects.map(project => [project.id, project]))
  const createdAt = input.at.toISOString()
  const notices: Notification[] = []
  for (const project of input.projects) {
    const paidAt = timestamp(project.purchasePaidAt)
    if (!['待回款', '回款中'].includes(project.status) || !Number.isFinite(paidAt)
      || input.at.getTime() <= paidAt + (project.ruleParametersSnapshot?.receiptWarningDays ?? 30) * 86_400_000) continue
    const receivableCents = Math.round((project.salesAmount ?? Number.NaN) * 100)
    if (!Number.isSafeInteger(receivableCents) || receivableCents <= 0) continue
    const summary = summarizeProjectReceipts(input.receipts.filter(batch =>
      batch.lines.some(line => line.projectId === project.id)), project.id, receivableCents)
    if (summary.gapCents <= 0) continue
    notices.push(roleNotification({ type: '回款超期预警', sourceId: project.id,
      role: 'super_admin', projectId: project.id,
      content: `众筹单【${project.id}】回款已超期，尚差 ${(summary.gapCents / 100).toFixed(2)} 元，请在复核事项中处置`,
      targetPage: 'customerReceipts', createdAt }))
  }
  for (const order of input.orders) {
    const project = byProject.get(order.projectId)
    if (!project || project.status !== '分配中' || order.status !== '有异议') continue
    for (const line of order.lines) {
      const issueAt = timestamp(line.issueAt)
      if (line.status !== '有异议' || !Number.isFinite(issueAt)
        || input.at.getTime() <= issueAt + (project.ruleParametersSnapshot?.issueHandlingHours ?? 72) * 3_600_000) continue
      notices.push(roleNotification({ type: '异议超时升级',
        sourceId: `${order.id}:${line.participantId}`, role: 'super_admin', projectId: project.id,
        content: `众筹单【${project.id}】有员工异议超时未处理，请跟进`,
        targetPage: 'distributionOrders', createdAt }))
    }
  }
  return notices
}
