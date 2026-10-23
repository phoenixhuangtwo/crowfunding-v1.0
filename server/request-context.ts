import type { IncomingMessage } from 'node:http'
import type { FileAsset, RequestContext } from './domain/models.ts'
import type { AppRepositories } from './persistence/repositories.ts'
import { appError } from './errors.ts'

const roles = ['employee', 'admin', 'finance', 'super_admin'] as const

export function requestContext(req: IncomingMessage): RequestContext {
  const userId = String(req.headers['x-user-id'] ?? '').trim()
  const role = String(req.headers['x-user-role'] ?? '').trim()
  if (!userId || !roles.includes(role as (typeof roles)[number])) {
    throw appError(401, 'REQUEST_CONTEXT_REQUIRED', '缺少有效访问身份')
  }
  return { userId, role: role as RequestContext['role'] }
}

function fileNotFound() {
  return appError(404, 'FILE_NOT_FOUND', '文件不存在或无权访问')
}

export async function authorizeAssetRead(context: RequestContext, asset: FileAsset, repos: AppRepositories) {
  if (asset.status !== 'ready') throw fileNotFound()
  if (context.role === 'super_admin') return
  if (asset.purpose === 'payment-proof') {
    const subscription = await repos.subscriptions.getById(asset.ownerId)
    if (context.role === 'finance' || subscription?.userId === context.userId) return
  }
  if (asset.purpose === 'settlement-invoice' && context.role === 'finance') return
  if (asset.purpose === 'receiving-code') {
    if (context.role === 'admin' || context.role === 'finance') return
    if (context.role === 'employee') {
      const linkedRules = await repos.rules.list({ receivingCodeId: asset.ownerId })
      if (linkedRules.length > 0) {
        const subscription = await repos.subscriptions.findOne({
          userId: context.userId,
          projectId: { $in: linkedRules.map(rule => rule.projectId) },
          pay: { $ne: '已释放' }
        })
        if (subscription) return
      }
    }
  }
  throw fileNotFound()
}
