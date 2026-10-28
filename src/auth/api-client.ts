import { clearAccessToken, readAccessToken, saveAccessToken } from './session.ts'

export type ApiErrorCode = 'AUTH_REQUIRED' | 'FORBIDDEN' | 'IAM_UNAVAILABLE' | 'API_INVALID_RESPONSE'

export class ApiError extends Error {
  constructor(readonly code: ApiErrorCode, readonly status?: number, message?: string) {
    super(message ?? code)
    this.name = 'ApiError'
  }
}

type TokenResponse = { accessToken: string; tokenType?: string; expiresIn?: number }

let refreshInFlight: Promise<string> | undefined

function navigateToLogin(): void {
  const target = '/api/auth/login'
  const location = (globalThis as { location?: { assign?: (url: string) => void; href?: string } }).location
  if (!location) return
  if (typeof location.assign === 'function') location.assign(target)
  else location.href = target
}

async function responseBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return undefined
  try { return JSON.parse(text) as unknown } catch { return undefined }
}

function errorForStatus(status: number, body?: unknown): ApiError {
  if (status === 401) return new ApiError('AUTH_REQUIRED', status, '需要有效的登录凭证')
  if (status === 403) return new ApiError('FORBIDDEN', status, '暂无访问该资源的权限')
  if (status === 503 && (!body || typeof body !== 'object' || (body as { error?: unknown }).error === 'IAM_UNAVAILABLE')) {
    return new ApiError('IAM_UNAVAILABLE', status, '统一身份服务暂不可用')
  }
  const message = body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string'
    ? (body as { message: string }).message : '接口请求失败'
  return new ApiError('API_INVALID_RESPONSE', status, message)
}

async function requestRefresh(): Promise<string> {
  let response: Response
  try {
    response = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' } })
  } catch {
    throw new ApiError('IAM_UNAVAILABLE', 503, '统一身份服务暂不可用')
  }
  const body = await responseBody(response)
  if (!response.ok) {
    const error = errorForStatus(response.status, body)
    if (response.status === 401) {
      clearAccessToken()
      navigateToLogin()
    }
    throw error
  }
  const token = body && typeof body === 'object' && typeof (body as TokenResponse).accessToken === 'string'
    ? (body as TokenResponse).accessToken : ''
  if (!token) throw new ApiError('IAM_UNAVAILABLE', 503, '统一身份服务响应无效')
  saveAccessToken(token)
  return token
}

export function refreshAccessToken(): Promise<string> {
  if (!refreshInFlight) {
    refreshInFlight = requestRefresh().finally(() => { refreshInFlight = undefined })
  }
  return refreshInFlight
}

function requestInit(options: RequestInit | undefined, token: string | null): RequestInit {
  const headers = new Headers(options?.headers)
  headers.delete('Authorization')
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const body = options?.body
  if (body instanceof FormData) headers.delete('Content-Type')
  else if (body !== undefined) headers.set('Content-Type', 'application/json')
  return { ...options, credentials: 'same-origin', headers }
}

async function send<T>(path: string, options: RequestInit | undefined, retried: boolean): Promise<T> {
  const token = readAccessToken()
  let response: Response
  try {
    response = await fetch(path, requestInit(options, token))
  } catch {
    throw new ApiError('IAM_UNAVAILABLE', 503, '统一身份服务暂不可用')
  }
  const body = await responseBody(response)
  if (response.status === 401 && !retried) {
    await refreshAccessToken()
    return send<T>(path, options, true)
  }
  if (response.status === 401 && retried) {
    clearAccessToken()
    navigateToLogin()
  }
  if (!response.ok) throw errorForStatus(response.status, body)
  return body as T
}

export function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  return send<T>(path, options, false)
}

/** Test-only reset; it does not touch browser storage or network state. */
export function __resetApiClientForTests(): void {
  refreshInFlight = undefined
}
