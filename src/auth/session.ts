export const ACCESS_TOKEN_KEY = 'crowdfunding.access_token'

function storage(): Storage | undefined {
  try {
    return typeof globalThis.sessionStorage !== 'undefined' ? globalThis.sessionStorage : undefined
  } catch {
    return undefined
  }
}

export function readAccessToken(): string | null {
  return storage()?.getItem(ACCESS_TOKEN_KEY) ?? null
}

export function saveAccessToken(token: string): void {
  if (!token || typeof token !== 'string') throw new TypeError('访问凭证无效')
  storage()?.setItem(ACCESS_TOKEN_KEY, token)
}

export function clearAccessToken(): void {
  storage()?.removeItem(ACCESS_TOKEN_KEY)
}
