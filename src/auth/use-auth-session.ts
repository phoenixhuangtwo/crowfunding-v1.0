import { ref, type Ref } from 'vue'
import { ApiError, apiRequest, refreshAccessToken } from './api-client.ts'
import { clearAccessToken, readAccessToken, saveAccessToken } from './session.ts'

export type AuthStatus = 'loading' | 'callback' | 'authenticated' | 'no-access' | 'unavailable' | 'callback-error'
export type PermissionMenu = {
  component?: string
  componentName?: string
  children?: readonly PermissionMenu[]
}
export type PermissionInfo = {
  user: { id: string; username: string; nickname: string; avatar?: string; deptId?: string }
  roles?: readonly string[]
  roleCodes?: readonly string[]
  permissions?: readonly string[]
  apiPermissions?: readonly string[]
  uiPermissions?: readonly string[]
  menus?: readonly PermissionMenu[]
  dataScope?: { all: boolean; self: boolean; deptIds: readonly string[] }
  clientId?: string
  tenantId?: string
}

type Browser = {
  location?: { pathname: string; search: string; assign?: (url: string) => void; href?: string }
  history?: { replaceState: (state: unknown, title: string, url?: string | URL | null) => void }
}

function browser(): Browser {
  const value = globalThis as unknown as { location?: Browser['location']; history?: Browser['history'] }
  return { location: value.location, history: value.history }
}

function navigateToLogin() {
  const location = browser().location
  if (!location) return
  if (typeof location.assign === 'function') location.assign('/api/auth/login')
  else location.href = '/api/auth/login'
}

function classify(error: unknown): AuthStatus {
  if (error instanceof ApiError && error.code === 'FORBIDDEN') return 'no-access'
  if (error instanceof ApiError && error.code === 'IAM_UNAVAILABLE') return 'unavailable'
  return 'callback-error'
}

export function useAuthSession() {
  const status = ref<AuthStatus>('loading')
  const permissionInfo: Ref<PermissionInfo | null> = ref(null)
  let readyResolve!: () => void
  const ready = new Promise<void>(resolve => { readyResolve = resolve })

  async function loadMe() {
    const payload = await apiRequest<{ data: PermissionInfo }>('/api/auth/me')
    if (!payload?.data?.user) throw new ApiError('API_INVALID_RESPONSE', 503, '统一身份服务响应无效')
    permissionInfo.value = payload.data
    status.value = 'authenticated'
  }

  async function initialize() {
    const { location, history } = browser()
    const callback = location?.pathname === '/oauth/callback'
    if (callback) {
      status.value = 'callback'
    const params = new URLSearchParams(location?.search ?? '')
    const code = params.get('code')
    const state = params.get('state')
    if (!code || !state || params.getAll('code').length !== 1 || params.getAll('state').length !== 1) {
        history?.replaceState({}, '', '/')
        status.value = 'callback-error'
        return
      }
      try {
        const payload = await apiRequest<{ accessToken: string; returnTo?: string }>('/api/auth/callback', {
          method: 'POST', body: JSON.stringify({ code, state })
        })
        if (!payload?.accessToken) throw new ApiError('API_INVALID_RESPONSE', 503, '授权回调响应无效')
        saveAccessToken(payload.accessToken)
        history?.replaceState({}, '', payload.returnTo || '/')
        await loadMe()
      } catch (error) {
        history?.replaceState({}, '', '/')
        status.value = classify(error)
        if (status.value === 'callback-error') clearAccessToken()
      }
      return
    }

    try {
      if (!readAccessToken()) await refreshAccessToken()
      await loadMe()
    } catch (error) {
      status.value = classify(error)
      if (error instanceof ApiError && error.code === 'AUTH_REQUIRED') {
        clearAccessToken()
        navigateToLogin()
      }
    }
  }

  async function startLogin() { navigateToLogin() }
  async function retry() { status.value = 'loading'; await initialize() }
  async function logout() {
    try { await apiRequest('/api/auth/logout', { method: 'POST', body: '{}' }) } catch { /* logout remains local even when IAM is unavailable */ }
    clearAccessToken()
    permissionInfo.value = null
    navigateToLogin()
  }

  void initialize().finally(readyResolve)
  return { status, permissionInfo, startLogin, retry, logout, ready }
}
