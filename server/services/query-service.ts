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

  listProjects() {
    return this.repos.projects.list({}, { sort: { deadline: 1, id: 1 } })
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
