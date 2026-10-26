import { createHash, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders } from 'node:http'
import type { IamConfig } from './config.ts'
import type { IamTokenPair } from './types.ts'

export const OAUTH_COOKIE_NAMES = [
  'crowdfunding_oauth_state',
  'crowdfunding_oauth_verifier',
  'crowdfunding_oauth_return'
] as const
export const REFRESH_COOKIE_NAME = 'crowdfunding_refresh'
const oauthTtlSeconds = 300
const refreshTtlSeconds = 30 * 24 * 60 * 60

export type OAuthDependencies = {
  now?: () => number
  randomBytes?: (size: number) => Uint8Array
}

type OAuthRequest = {
  headers: IncomingHttpHeaders
  rawHeaders?: readonly string[]
}

type OAuthIam = {
  config: IamConfig
  exchangeCode(input: { code: string; state: string; verifier: string }): Promise<IamTokenPair>
}

export class OAuthFlowError extends Error {
  readonly status = 400
  readonly code = 'OAUTH_CALLBACK_INVALID'

  constructor() {
    super('OAuth 回调校验失败')
    this.name = 'OAuthFlowError'
  }
}

function invalid(): never {
  throw new OAuthFlowError()
}

function secure(config: IamConfig): string {
  return config.refreshCookieSecure ? '; Secure' : ''
}

function setCookie(name: string, value: string, options: { maxAge: number; sameSite: 'Lax' | 'Strict' }, config: IamConfig): string {
  return `${name}=${encodeURIComponent(value)}; Max-Age=${options.maxAge}; HttpOnly; SameSite=${options.sameSite}; Path=/api/auth${secure(config)}`
}

function deleteCookie(name: string, sameSite: 'Lax' | 'Strict', config: IamConfig): string {
  return `${name}=; Max-Age=0; HttpOnly; SameSite=${sameSite}; Path=/api/auth${secure(config)}`
}

export function oauthCookieDeletions(config: IamConfig): string[] {
  return OAUTH_COOKIE_NAMES.map(name => deleteCookie(name, 'Lax', config))
}

export function refreshCookieDeletion(config: IamConfig): string {
  return deleteCookie(REFRESH_COOKIE_NAME, 'Strict', config)
}

export function allAuthCookieDeletions(config: IamConfig): string[] {
  return [...oauthCookieDeletions(config), refreshCookieDeletion(config)]
}

export function createRefreshCookie(config: IamConfig, refreshToken: string): string {
  if (!refreshToken || refreshToken.length > 8192) return invalid()
  return setCookie(REFRESH_COOKIE_NAME, refreshToken, { maxAge: refreshTtlSeconds, sameSite: 'Strict' }, config)
}

function normalizeReturnTo(input: unknown): { valid: boolean; value: string } {
  if (typeof input !== 'string' || input.length === 0 || input.length > 2048) return { valid: false, value: '/' }
  let decoded: string
  try {
    decoded = decodeURIComponent(input)
  } catch {
    return { valid: false, value: '/' }
  }
  if (!input.startsWith('/') || input.startsWith('//') || input.includes('\\') || decoded.includes('\\')) {
    return { valid: false, value: '/' }
  }
  if (/[%]5c/i.test(input) || /[\u0000-\u001f\u007f]/.test(input) || /[\u0000-\u001f\u007f]/.test(decoded)) {
    return { valid: false, value: '/' }
  }
  try {
    const url = new URL(input, 'https://crowdfunding.invalid')
    if (url.origin !== 'https://crowdfunding.invalid' || !url.pathname.startsWith('/') || url.pathname.startsWith('//')) {
      return { valid: false, value: '/' }
    }
    if (url.hash.startsWith('#//') || url.hash.includes('\\')) return { valid: false, value: '/' }
    return { valid: true, value: `${url.pathname}${url.search}${url.hash}` }
  } catch {
    return { valid: false, value: '/' }
  }
}

function stateValue(now: number, entropy: Uint8Array): string {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('OAuth clock invalid')
  const bytes = Buffer.alloc(8 + entropy.byteLength)
  bytes.writeBigUInt64BE(BigInt(now), 0)
  Buffer.from(entropy).copy(bytes, 8)
  return bytes.toString('base64url')
}

function stateCreatedAt(value: string): number {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return invalid()
  let bytes: Buffer
  try {
    bytes = Buffer.from(value, 'base64url')
  } catch {
    return invalid()
  }
  if (bytes.length !== 40 || bytes.toString('base64url') !== value) return invalid()
  const timestamp = bytes.readBigUInt64BE(0)
  if (timestamp > BigInt(Number.MAX_SAFE_INTEGER)) return invalid()
  return Number(timestamp)
}

export async function beginOAuth(
  config: IamConfig,
  returnTo: unknown = '/',
  dependencies: OAuthDependencies = {}
): Promise<{ location: string; cookies: string[] }> {
  const now = (dependencies.now ?? Date.now)()
  const random = dependencies.randomBytes ?? (size => nodeRandomBytes(size))
  const verifier = Buffer.from(random(32)).toString('base64url')
  const state = stateValue(now, random(32))
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const safeReturn = normalizeReturnTo(returnTo).value
  const location = new URL('/oauth/login', config.baseUrl)
  location.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri.href,
    response_type: 'code',
    scope: config.scopes.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  }).toString()
  return {
    location: location.href,
    cookies: [
      setCookie(OAUTH_COOKIE_NAMES[0], state, { maxAge: oauthTtlSeconds, sameSite: 'Lax' }, config),
      setCookie(OAUTH_COOKIE_NAMES[1], verifier, { maxAge: oauthTtlSeconds, sameSite: 'Lax' }, config),
      setCookie(OAUTH_COOKIE_NAMES[2], safeReturn, { maxAge: oauthTtlSeconds, sameSite: 'Lax' }, config)
    ]
  }
}

function cookieHeader(req: OAuthRequest): string {
  const raw = req.rawHeaders ?? []
  const rawCookies: string[] = []
  for (let index = 0; index < raw.length; index += 2) {
    if (raw[index]?.toLowerCase() === 'cookie') rawCookies.push(raw[index + 1] ?? '')
  }
  if (rawCookies.length > 1) return invalid()
  const value = rawCookies[0] ?? req.headers.cookie
  if (Array.isArray(value)) return invalid()
  return value ?? ''
}

export function readCookies(req: OAuthRequest): ReadonlyMap<string, string> {
  const parsed = new Map<string, string>()
  const header = cookieHeader(req)
  if (!header) return parsed
  for (const part of header.split(';')) {
    const equals = part.indexOf('=')
    if (equals <= 0) return invalid()
    const name = part.slice(0, equals).trim()
    const encoded = part.slice(equals + 1).trim()
    if (!name || parsed.has(name)) return invalid()
    try {
      parsed.set(name, decodeURIComponent(encoded))
    } catch {
      return invalid()
    }
  }
  return parsed
}

function requiredBodyString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return invalid()
  return value
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left)
  const rightBytes = Buffer.from(right)
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

export async function completeOAuth(
  req: OAuthRequest,
  body: Record<string, unknown>,
  iam: OAuthIam,
  dependencies: OAuthDependencies = {}
): Promise<{ accessToken: string; tokenType: 'Bearer'; expiresIn: number; cookies: string[]; returnTo: string }> {
  const code = requiredBodyString(body.code, 4096)
  const suppliedState = requiredBodyString(body.state, 512)
  const cookies = readCookies(req)
  const expectedState = cookies.get(OAUTH_COOKIE_NAMES[0]) ?? invalid()
  const verifier = cookies.get(OAUTH_COOKIE_NAMES[1]) ?? invalid()
  const rawReturnTo = cookies.get(OAUTH_COOKIE_NAMES[2]) ?? invalid()
  if (!constantTimeEqual(suppliedState, expectedState)) return invalid()
  const createdAt = stateCreatedAt(expectedState)
  const now = (dependencies.now ?? Date.now)()
  if (!Number.isSafeInteger(now) || now < createdAt || now - createdAt > oauthTtlSeconds * 1000) return invalid()
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return invalid()
  const returnTo = normalizeReturnTo(rawReturnTo)
  if (!returnTo.valid) return invalid()
  const pair = await iam.exchangeCode({ code, state: suppliedState, verifier })
  if (!pair.accessToken || !pair.refreshToken || pair.tokenType !== 'Bearer' || !Number.isSafeInteger(pair.expiresIn) || pair.expiresIn < 0) {
    return invalid()
  }
  return {
    accessToken: pair.accessToken,
    tokenType: 'Bearer',
    expiresIn: pair.expiresIn,
    returnTo: returnTo.value,
    cookies: [...oauthCookieDeletions(iam.config), createRefreshCookie(iam.config, pair.refreshToken)]
  }
}
