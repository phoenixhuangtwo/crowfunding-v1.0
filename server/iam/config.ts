import { normalizeIamId } from './json.ts'

export type IamConfig = {
  baseUrl: URL
  clientId: 'crowdfunding'
  clientSecret: string
  redirectUri: URL
  scopes: readonly ['openid', 'profile']
  connectTimeoutMs: number
  readTimeoutMs: number
  refreshCookieSecure: boolean
  allowedOrigin: string
  multiTenantEnabled: boolean
  defaultTenantId: string
}

type Environment = NodeJS.ProcessEnv

function required(env: Environment, name: string): string {
  const value = env[name]
  if (!value || !value.trim()) throw new Error(`缺少服务端配置 ${name}`)
  return value.trim()
}

function httpUrl(env: Environment, name: string): URL {
  let url: URL
  try {
    url = new URL(required(env, name))
  } catch {
    throw new Error(`${name} 必须为有效 URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} 仅允许 http 或 https URL`)
  }
  if (url.username || url.password) throw new Error(`${name} 不允许 URL credentials`)
  return url
}

function exactOrigin(env: Environment): string {
  if (env.APP_ALLOWED_ORIGIN?.trim() === '*') {
    throw new Error('APP_ALLOWED_ORIGIN 必须是精确 Origin')
  }
  const url = httpUrl(env, 'APP_ALLOWED_ORIGIN')
  if (url.hostname.includes('*') || url.origin.includes('*') || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('APP_ALLOWED_ORIGIN 必须是精确 Origin')
  }
  return url.origin
}

function timeout(env: Environment, name: string, fallback: number): number {
  const value = env[name]
  if (value === undefined) return fallback
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${name} 必须为正整数毫秒数`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} 必须为安全整数毫秒数`)
  return parsed
}

function boolean(env: Environment, name: string, fallback: boolean): boolean {
  const value = env[name]
  if (value === undefined) return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`${name} 必须为 true 或 false`)
}

function tenantId(env: Environment): string {
  const value = env.IAM_DEFAULT_TENANT_ID
  try {
    return normalizeIamId(value === undefined ? '0' : value, { allowZero: true })
  } catch {
    throw new Error('IAM_DEFAULT_TENANT_ID 必须为非负十进制整数')
  }
}

export function loadIamConfig(env: Environment = process.env): IamConfig {
  const baseUrl = httpUrl(env, 'IAM_BASE_URL')
  const redirectUri = httpUrl(env, 'IAM_REDIRECT_URI')
  const allowedOrigin = exactOrigin(env)
  if (redirectUri.origin !== allowedOrigin) {
    throw new Error('IAM_REDIRECT_URI 的 Origin 必须等于 APP_ALLOWED_ORIGIN')
  }
  if (required(env, 'IAM_CLIENT_ID') !== 'crowdfunding') {
    throw new Error('IAM_CLIENT_ID 必须为 crowdfunding')
  }
  const multiTenantEnabled = boolean(env, 'IAM_MULTI_TENANT_ENABLED', false)
  const defaultTenantId = tenantId(env)
  if (!multiTenantEnabled && defaultTenantId !== '0') {
    throw new Error('IAM_DEFAULT_TENANT_ID 在关闭多租户时必须为 0')
  }

  return {
    baseUrl,
    clientId: 'crowdfunding',
    clientSecret: required(env, 'IAM_CLIENT_SECRET'),
    redirectUri,
    scopes: ['openid', 'profile'],
    connectTimeoutMs: timeout(env, 'IAM_CONNECT_TIMEOUT_MS', 2000),
    readTimeoutMs: timeout(env, 'IAM_READ_TIMEOUT_MS', 5000),
    refreshCookieSecure: boolean(env, 'IAM_REFRESH_COOKIE_SECURE', false),
    allowedOrigin,
    multiTenantEnabled,
    defaultTenantId
  }
}
