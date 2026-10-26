import type { Filter } from 'mongodb'
import type { IamDataScope, IamRequestContext } from './types.ts'
import { normalizeIamId } from './json.ts'

export type OwnershipFields = {
  tenantId: string
  ownerUserId: string
  ownerDeptId?: string
}

export type DataScopeConfig = {
  multiTenantEnabled?: boolean
  defaultTenantId?: string
}

export type ScopeFilter = {
  tenantId: string
  ownerUserId?: string
  ownerDeptId?: { $in: string[] }
  $or?: Array<{ ownerUserId: string } | { ownerDeptId: { $in: string[] } }>
  _scopeDenied?: { $eq: true }
}

export class ScopeDeniedError extends Error {
  readonly status = 404 as const
  readonly code = 'SCOPE_DENIED' as const
  constructor() {
    super('资源不存在或无权访问')
    this.name = 'ScopeDeniedError'
  }
}

function normalizedTenant(context: Pick<IamRequestContext, 'tenantId'>, config: DataScopeConfig): string {
  const tenantId = normalizeIamId(context.tenantId, { allowZero: true })
  const enabled = config.multiTenantEnabled ?? false
  const defaultTenantId = normalizeIamId(config.defaultTenantId ?? '0', { allowZero: true })
  if (!enabled && defaultTenantId !== '0') throw new Error('关闭多租户时默认租户必须为 0')
  if (!enabled && tenantId !== defaultTenantId) throw new Error('请求租户与服务端配置不一致')
  return enabled ? tenantId : defaultTenantId
}

function normalizedScope(scope: IamDataScope | undefined) {
  if (!scope || typeof scope.all !== 'boolean' || typeof scope.self !== 'boolean' || !Array.isArray(scope.deptIds)) {
    return null
  }
  const deptIds = scope.deptIds.map(id => normalizeIamId(id))
  return { all: scope.all, self: scope.self, deptIds }
}

export function ownershipFrom(context: IamRequestContext, config: DataScopeConfig = {}): OwnershipFields {
  const tenantId = normalizedTenant(context, config)
  const ownerUserId = normalizeIamId(context.userId)
  const ownerDeptId = context.user?.deptId === undefined ? undefined : normalizeIamId(context.user.deptId)
  return ownerDeptId === undefined ? { tenantId, ownerUserId } : { tenantId, ownerUserId, ownerDeptId }
}

export function scopeFilter(context: IamRequestContext, config: DataScopeConfig = {}): ScopeFilter {
  const ownership = ownershipFrom(context, config)
  const scope = normalizedScope(context.dataScope)
  if (!scope || (!scope.all && !scope.self && scope.deptIds.length === 0)) {
    return { tenantId: ownership.tenantId, _scopeDenied: { $eq: true } }
  }
  if (scope.all) return { tenantId: ownership.tenantId }
  if (scope.self && scope.deptIds.length === 0) return { tenantId: ownership.tenantId, ownerUserId: ownership.ownerUserId }
  if (scope.self) {
    return {
      tenantId: ownership.tenantId,
      $or: [{ ownerUserId: ownership.ownerUserId }, { ownerDeptId: { $in: scope.deptIds } }]
    }
  }
  return { tenantId: ownership.tenantId, ownerDeptId: { $in: scope.deptIds } }
}

type ScopedEntity = { tenantId?: unknown; ownerUserId?: unknown; ownerDeptId?: unknown }

export function assertScopedEntity(entity: ScopedEntity | null | undefined, context: IamRequestContext, config: DataScopeConfig = {}): asserts entity is ScopedEntity & OwnershipFields {
  if (!entity) throw new ScopeDeniedError()
  const filter = scopeFilter(context, config)
  if (filter._scopeDenied) throw new ScopeDeniedError()
  let tenantId: string
  try { tenantId = normalizeIamId(entity.tenantId, { allowZero: true }) } catch { throw new ScopeDeniedError() }
  if (tenantId !== filter.tenantId) throw new ScopeDeniedError()
  if (filter.$or) {
    let userMatches = false
    const userEntry = filter.$or[0]
    if (userEntry && 'ownerUserId' in userEntry) {
      try { userMatches = normalizeIamId(entity.ownerUserId) === userEntry.ownerUserId } catch { /* try department */ }
    }
    if (userMatches) return
    const deptEntry = filter.$or.find(entry => 'ownerDeptId' in entry)
    const allowedDept = deptEntry && 'ownerDeptId' in deptEntry ? deptEntry.ownerDeptId.$in : []
    let deptId: string
    try { deptId = normalizeIamId(entity.ownerDeptId) } catch { throw new ScopeDeniedError() }
    if (!allowedDept.includes(deptId)) throw new ScopeDeniedError()
    return
  }
  if (filter.ownerUserId !== undefined) {
    let userId: string
    try { userId = normalizeIamId(entity.ownerUserId) } catch { throw new ScopeDeniedError() }
    if (userId !== filter.ownerUserId) {
      throw new ScopeDeniedError()
    }
    return
  }
  const allowedDept = filter.ownerDeptId?.$in
  if (allowedDept) {
    let deptId: string
    try { deptId = normalizeIamId(entity.ownerDeptId) } catch { throw new ScopeDeniedError() }
    if (!allowedDept.includes(deptId)) throw new ScopeDeniedError()
  }
}

export function asScopeFilter<T extends object>(context: IamRequestContext, config: DataScopeConfig = {}): Filter<T> {
  return scopeFilter(context, config) as Filter<T>
}
