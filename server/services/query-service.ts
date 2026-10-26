import type { ReceivingCode, RequestContext } from '../domain/models.ts'
import type { AppRepositories } from '../persistence/repositories.ts'

export function presentReceivingCode(code: ReceivingCode) {
  return {
    ...code,
    imageUrl: code.imageAssetId ? `/api/files/${encodeURIComponent(code.imageAssetId)}/content` : undefined
  }
}

export class QueryService {
  constructor(private readonly repos: AppRepositories) {}

  async listProjects(context?: RequestContext) {
    const projects = await this.repos.projects.list(
      context?.role === 'employee' ? { status: '未满额' } : {},
      { sort: { deadline: 1, id: 1 } }
    )
    if (context?.role !== 'employee') return projects
    return projects.filter(project => {
      const deadline = project.deadline.replace(' ', 'T')
      const cutoff = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(deadline)
        ? Date.parse(`${deadline.length === 16 ? `${deadline}:00` : deadline}+08:00`)
        : NaN
      return Number.isFinite(cutoff) && cutoff >= Date.now()
    })
  }

  listSubscriptions(context?: RequestContext) {
    const filter = context?.role === 'employee' ? { userId: context.userId } : {}
    return this.repos.subscriptions.list(filter, { sort: { createdAt: -1, id: -1 } })
  }

  async listReceivingCodes() {
    return (await this.repos.receivingCodes.list({}, { sort: { updatedAt: -1, id: 1 } })).map(presentReceivingCode)
  }

  async state() {
    const [projects, subscriptions, rules, receivingCodes, auditLogs, riskEvents] = await Promise.all([
      this.listProjects(),
      this.listSubscriptions(),
      this.repos.rules.list(),
      this.listReceivingCodes(),
      this.repos.auditLogs.list({}, { sort: { time: -1 } }),
      this.repos.riskEvents.list({}, { sort: { time: -1 } })
    ])
    return { projects, subscriptions, rules, receivingCodes, auditLogs, riskEvents }
  }
}
