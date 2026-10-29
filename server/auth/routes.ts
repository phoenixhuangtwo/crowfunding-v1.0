import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { IamConfig } from '../iam/config.ts'
import type { IamTokenPair } from '../iam/types.ts'
import { IamProtocolError, IamUnauthorizedError, IamUnavailableError } from '../iam/errors.ts'
import {
  OAuthFlowError,
  allAuthCookieDeletions,
  beginOAuth,
  completeOAuth,
  createRefreshCookie,
  oauthCookieDeletions,
  readCookies,
  REFRESH_COOKIE_NAME,
  refreshCookieDeletion,
  type OAuthDependencies
} from '../iam/oauth.ts'
import { sendJson, sendNoContent, sendRedirect } from '../http-response.ts'
import { parseIamJson } from '../iam/json.ts'

type AuthIam = {
  config: IamConfig
  exchangeCode(input: { code: string; state: string; verifier: string }): Promise<IamTokenPair>
  refresh(refreshToken: string): Promise<IamTokenPair>
  revoke(accessToken: string): Promise<boolean>
}

export type AuthRouteDependencies = {
  config: IamConfig
  iam: AuthIam
  oauth?: OAuthDependencies
}

class AuthRouteError extends Error {
  constructor(readonly status: 400 | 401 | 409, readonly code: string, message: string) {
    super(message)
    this.name = 'AuthRouteError'
  }
}

const refreshInFlight = new Set<string>()

async function readStrictJson(req: IncomingMessage, maxBytes = 16 * 1024, allowEmpty = false): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const value = Buffer.from(chunk)
    size += value.length
    if (size > maxBytes) throw new AuthRouteError(400, 'AUTH_REQUEST_INVALID', '认证请求无效')
    chunks.push(value)
  }
  const text = Buffer.concat(chunks, size).toString('utf8')
  if (!text) {
    if (allowEmpty) return {}
    throw new AuthRouteError(400, 'AUTH_REQUEST_INVALID', '认证请求无效')
  }
  let parsed: unknown
  try {
    parsed = parseIamJson(text)
  } catch {
    throw new AuthRouteError(400, 'AUTH_REQUEST_INVALID', '认证请求无效')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AuthRouteError(400, 'AUTH_REQUEST_INVALID', '认证请求无效')
  }
  return parsed as Record<string, unknown>
}

function requiredRefresh(req: IncomingMessage): string {
  let cookies: ReadonlyMap<string, string>
  try {
    cookies = readCookies(req)
  } catch {
    throw new AuthRouteError(401, 'REFRESH_TOKEN_INVALID', '刷新凭证无效')
  }
  const token = cookies.get(REFRESH_COOKIE_NAME)
  if (!token || token.length > 8192) throw new AuthRouteError(401, 'REFRESH_TOKEN_INVALID', '刷新凭证无效')
  return token
}

function rawHeaderValues(req: IncomingMessage, name: string): string[] {
  const values: string[] = []
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === name.toLowerCase()) values.push(req.rawHeaders[index + 1] ?? '')
  }
  return values.length > 0 ? values : (typeof req.headers[name.toLowerCase()] === 'string' ? [req.headers[name.toLowerCase()] as string] : [])
}

function oneBearer(req: IncomingMessage): string {
  const values = rawHeaderValues(req, 'authorization')
  if (values.length !== 1) throw new AuthRouteError(401, 'ACCESS_TOKEN_INVALID', '访问凭证无效')
  const match = values[0]?.match(/^Bearer ([A-Za-z0-9._~+\/-]{1,8192})$/)
  if (!match) throw new AuthRouteError(401, 'ACCESS_TOKEN_INVALID', '访问凭证无效')
  return match[1]
}

function safeError(req: IncomingMessage, res: ServerResponse, config: IamConfig, error: unknown, cookies?: readonly string[]): void {
  if (error instanceof AuthRouteError) {
    sendJson(req, res, config.allowedOrigin, error.status, { error: error.code, message: error.message }, cookies)
    return
  }
  if (error instanceof OAuthFlowError) {
    sendJson(req, res, config.allowedOrigin, 400, { error: error.code, message: error.message }, cookies)
    return
  }
  if (error instanceof IamUnauthorizedError) {
    sendJson(req, res, config.allowedOrigin, 401, { error: 'IAM_UNAUTHORIZED', message: 'IAM 凭证无效' }, cookies)
    return
  }
  if (error instanceof IamUnavailableError || error instanceof IamProtocolError) {
    sendJson(req, res, config.allowedOrigin, 503, { error: 'IAM_UNAVAILABLE', message: 'IAM 服务暂不可用' }, cookies)
    return
  }
  sendJson(req, res, config.allowedOrigin, 503, { error: 'IAM_UNAVAILABLE', message: 'IAM 服务暂不可用' }, cookies)
}

function methodNotAllowed(req: IncomingMessage, res: ServerResponse, config: IamConfig): void {
  sendJson(req, res, config.allowedOrigin, 405, { error: 'METHOD_NOT_ALLOWED', message: '请求方法不允许' })
}

export async function handleAuthRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  dependencies: AuthRouteDependencies
): Promise<boolean> {
  const { config, iam } = dependencies
  const known = ['/api/auth/login', '/api/auth/callback', '/api/auth/refresh', '/api/auth/logout']
  if (!known.includes(url.pathname)) return false

  const expectedMethod = url.pathname === '/api/auth/login' ? 'GET' : 'POST'
  if (req.method !== expectedMethod) {
    methodNotAllowed(req, res, config)
    return true
  }

  if (url.pathname === '/api/auth/login') {
    try {
      if (url.searchParams.getAll('returnTo').length > 1) throw new AuthRouteError(400, 'AUTH_REQUEST_INVALID', '认证请求无效')
      const result = await beginOAuth(config, url.searchParams.get('returnTo') ?? '/', dependencies.oauth)
      sendRedirect(req, res, config.allowedOrigin, result.location, result.cookies)
    } catch (error) {
      safeError(req, res, config, error)
    }
    return true
  }

  if (url.pathname === '/api/auth/callback') {
    const deletions = oauthCookieDeletions(config)
    try {
      const body = await readStrictJson(req)
      const result = await completeOAuth(req, body, iam, dependencies.oauth)
      sendJson(req, res, config.allowedOrigin, 200, {
        accessToken: result.accessToken,
        tokenType: result.tokenType,
        expiresIn: result.expiresIn,
        returnTo: result.returnTo
      }, result.cookies)
    } catch (error) {
      const mapped = error instanceof IamUnauthorizedError
        ? new OAuthFlowError()
        : error
      safeError(req, res, config, mapped, deletions)
    }
    return true
  }

  if (url.pathname === '/api/auth/refresh') {
    let refreshToken: string
    try {
      refreshToken = requiredRefresh(req)
    } catch (error) {
      safeError(req, res, config, error, [refreshCookieDeletion(config)])
      return true
    }
    const digest = createHash('sha256').update(refreshToken).digest('base64url')
    if (refreshInFlight.has(digest)) {
      safeError(req, res, config, new AuthRouteError(409, 'REFRESH_IN_PROGRESS', '刷新请求正在处理'))
      return true
    }
    refreshInFlight.add(digest)
    try {
      const pair = await iam.refresh(refreshToken)
      sendJson(req, res, config.allowedOrigin, 200, {
        accessToken: pair.accessToken,
        tokenType: pair.tokenType,
        expiresIn: pair.expiresIn
      }, [createRefreshCookie(config, pair.refreshToken)])
    } catch (error) {
      safeError(req, res, config, error, error instanceof IamUnauthorizedError ? [refreshCookieDeletion(config)] : undefined)
    } finally {
      refreshInFlight.delete(digest)
    }
    return true
  }

  try {
    if ([...url.searchParams.keys()].some(key => /token|code|state/i.test(key))) {
      throw new AuthRouteError(400, 'AUTH_REQUEST_INVALID', '退出请求不允许携带凭证参数')
    }
    const body = await readStrictJson(req, 16 * 1024, true)
    if (Object.keys(body).some(key => /token|code|state/i.test(key))) {
      throw new AuthRouteError(400, 'AUTH_REQUEST_INVALID', '退出请求不允许携带凭证参数')
    }
    const accessToken = oneBearer(req)
    await iam.revoke(accessToken)
    sendNoContent(req, res, config.allowedOrigin, 204, allAuthCookieDeletions(config))
  } catch (error) {
    safeError(req, res, config, error, allAuthCookieDeletions(config))
  }
  return true
}
