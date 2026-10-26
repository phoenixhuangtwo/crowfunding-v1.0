import type { IncomingMessage } from 'node:http'
import type { FileAsset, RequestContext } from './domain/models.ts'
import type { AppRepositories } from './persistence/repositories.ts'
import { appError } from './errors.ts'
import type { IamRequestContext } from './iam/types.ts'

const authenticated = new WeakMap<IncomingMessage, IamRequestContext>()

export function setAuthenticatedContext(req: IncomingMessage, context: IamRequestContext) {
  authenticated.set(req, context)
}

export function iamContextFor(req: IncomingMessage): IamRequestContext {
  const context = authenticated.get(req)
  if (!context) throw appError(401, 'REQUEST_CONTEXT_REQUIRED', '缺少有效 IAM 访问身份')
  return context
}

export function requestContext(req: IncomingMessage): RequestContext {
  const context = iamContextFor(req)
  const roles = context.roleCodes ?? []
  const role: RequestContext['role'] = roles.includes('super_admin') || roles.includes('super-admin') ? 'super_admin'
    : roles.includes('finance') ? 'finance' : roles.includes('admin') ? 'admin' : 'employee'
  return { userId: context.userId, role }
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
