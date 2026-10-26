import type { IncomingMessage } from 'node:http'
import { parseBearer, BearerError } from './bearer.ts'
import { IamDeniedError, IamProtocolError, IamUnauthorizedError, IamUnavailableError } from '../iam/errors.ts'
import type { IamClient } from '../iam/client.ts'
import type { IamMenu, IamPermissionInfo, IamRequestContext, IamTokenClaims } from '../iam/types.ts'
import type { IamConfig } from '../iam/config.ts'
import { permissionFor, type ApiPermissionCode, UnregisteredPermissionError } from '../iam/permissions.ts'
import { normalizeIamId } from '../iam/json.ts'
import { reviewPermissionFor } from '../iam/permissions.ts'

type AuthIam = Pick<IamClient, 'checkToken' | 'decideApi'> & Partial<Pick<IamClient, 'permissionInfo'>> & { config?: Pick<IamConfig, 'multiTenantEnabled' | 'defaultTenantId'> }
type PermissionIam = Pick<IamClient, 'decideApi'>
export type AuthMiddlewareDependencies = { iam: AuthIam; config?: Pick<IamConfig, 'multiTenantEnabled' | 'defaultTenantId'> }
export type PermissionDependencies = { iam: PermissionIam }

export class AuthBoundaryError extends Error {
  constructor(readonly status: 401 | 403 | 404 | 503, readonly code: string, message: string) {
    super(message)
    this.name = 'AuthBoundaryError'
  }
}

function boundary(error: unknown): AuthBoundaryError {
  if (error instanceof AuthBoundaryError) return error
  if (error instanceof BearerError || error instanceof IamUnauthorizedError) return new AuthBoundaryError(401, 'AUTH_REQUIRED', '需要有效的登录凭证')
  if (error instanceof IamDeniedError) return new AuthBoundaryError(403, 'PERMISSION_DENIED', '没有访问该接口的权限')
  if (error instanceof UnregisteredPermissionError) return new AuthBoundaryError(404, 'NOT_FOUND', '接口不存在')
  if (error instanceof IamUnavailableError || error instanceof IamProtocolError) return new AuthBoundaryError(503, 'IAM_UNAVAILABLE', 'IAM 服务暂不可用')
  return new AuthBoundaryError(503, 'IAM_UNAVAILABLE', 'IAM 服务暂不可用')
}

function freezeMenu(menu: IamMenu): IamMenu {
  return Object.freeze({
    ...menu,
    children: Object.freeze((menu.children ?? []).map(freezeMenu))
  })
}

function freezePermissionInfo(info: IamPermissionInfo) {
  return {
    user: Object.freeze({ ...info.user }),
    roleCodes: Object.freeze([...(info.roleCodes ?? [])]),
    permissions: Object.freeze([...(info.permissions ?? [])]),
    apiPermissions: Object.freeze([...(info.apiPermissions ?? [])]),
    uiPermissions: Object.freeze([...(info.uiPermissions ?? [])]),
    dataScope: Object.freeze({
      all: info.dataScope.all,
      self: info.dataScope.self,
      deptIds: Object.freeze([...(info.dataScope.deptIds ?? [])])
    }),
    menus: Object.freeze((info.menus ?? []).map(freezeMenu))
  }
}

function freezeContext(claims: IamTokenClaims, accessToken: string, info?: IamPermissionInfo): IamRequestContext {
  const permissionInfo = info ? freezePermissionInfo(info) : undefined
  const scopes = Object.freeze([...claims.scopes])
  const context: IamRequestContext = {
    accessToken,
    tenantId: String(claims.tenantId),
    userId: String(claims.userId),
    clientId: 'crowdfunding',
    scopes,
    ...(permissionInfo ?? {})
  }
  return Object.freeze(context)
}

/** Stable client-facing projection used by /api/auth/me. */
export function permissionInfoForClient(context: IamRequestContext) {
  return {
    user: context.user,
    roles: context.roleCodes ?? [],
    roleCodes: context.roleCodes ?? [],
    permissions: context.permissions ?? [],
    apiPermissions: context.apiPermissions ?? [],
    uiPermissions: context.uiPermissions ?? [],
    menus: context.menus ?? [],
    dataScope: context.dataScope,
    clientId: context.clientId,
    tenantId: context.tenantId
  }
}

function validateClaims(claims: IamTokenClaims, config?: Pick<IamConfig, 'multiTenantEnabled' | 'defaultTenantId'>): IamTokenClaims {
  if (!claims || claims.active !== true || claims.clientId !== 'crowdfunding') throw new IamUnauthorizedError()
  try {
    const userId = normalizeIamId(claims.userId)
    const tenantId = normalizeIamId(claims.tenantId, { allowZero: true })
    if (config && !config.multiTenantEnabled && tenantId !== config.defaultTenantId) throw new Error('tenant mismatch')
    return { ...claims, userId, tenantId }
  } catch {
    throw new IamUnauthorizedError()
  }
}

export function validateReviewAction(body: Record<string, unknown>): ApiPermissionCode {
  const keys = ['result', 'action'].filter(key => Object.prototype.hasOwnProperty.call(body, key))
  if (keys.length !== 1) throw new Error('复核动作无效')
  return reviewPermissionFor(body[keys[0]!])
}

export async function authenticateRequest(req: IncomingMessage, dependencies?: AuthMiddlewareDependencies): Promise<IamRequestContext> {
  if (!dependencies) throw boundary(new IamUnavailableError())
  const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (requestUrl.searchParams.has('access_token') || /(?:^|;)\s*access_token\s*=/.test(req.headers.cookie ?? '')) {
    throw boundary(new BearerError('请求不允许通过非 Authorization 位置传递凭证'))
  }
  const requestBody = (req as IncomingMessage & { body?: unknown }).body
  if (requestBody && typeof requestBody === 'object' && Object.prototype.hasOwnProperty.call(requestBody, 'access_token')) {
    throw boundary(new BearerError('请求不允许通过非 Authorization 位置传递凭证'))
  }
  let token: string
  try { token = parseBearer({ ...req.headers, rawHeaders: req.rawHeaders }) } catch (error) { throw boundary(error) }
  let claims: IamTokenClaims
  const config = dependencies.config ?? dependencies.iam.config
  try { claims = validateClaims(await dependencies.iam.checkToken(token), config) } catch (error) { throw boundary(error) }
  const pathname = requestUrl.pathname
  let code: ApiPermissionCode
  try { code = permissionFor(req.method ?? 'GET', pathname) } catch (error) { throw boundary(error) }
  try {
    if (await dependencies.iam.decideApi(token, code, claims.tenantId) !== true) throw new IamDeniedError()
  } catch (error) { throw boundary(error) }
  let info: IamPermissionInfo | undefined
  // Hydrate the immutable request context with IAM user/role/DataScope for all
  // business routes. Test doubles may omit permissionInfo and then remain
  // intentionally scope-less (which fails closed in data-scope helpers).
  if (dependencies.iam.permissionInfo) {
    try { info = await dependencies.iam.permissionInfo(token) } catch (error) { throw boundary(error) }
  }
  return freezeContext(claims, token, info)
}

export async function requireApiPermission(context: IamRequestContext, code: ApiPermissionCode, dependencies?: PermissionDependencies): Promise<void> {
  if (!dependencies) throw boundary(new IamUnavailableError())
  try {
    if (await dependencies.iam.decideApi(context.accessToken, code, context.tenantId) !== true) throw new IamDeniedError()
  } catch (error) {
    throw boundary(error)
  }
}

export function authErrorResponse(error: unknown): AuthBoundaryError {
  return boundary(error)
}
