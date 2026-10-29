import type { IncomingHttpHeaders } from 'node:http'

export type BearerHeaders = Partial<Record<string, string | string[]>> & { rawHeaders?: readonly string[] }

export class BearerError extends Error {
  constructor(message = '请求必须包含唯一 Bearer 凭证') {
    super(message)
    this.name = 'BearerError'
  }
}

function rawAuthorizationValues(headers: BearerHeaders): string[] {
  const raw = headers.rawHeaders
  if (Array.isArray(raw)) {
    const values: string[] = []
    for (let index = 0; index + 1 < raw.length; index += 2) {
      if (String(raw[index]).toLowerCase() === 'authorization') values.push(String(raw[index + 1] ?? ''))
    }
    if (values.length > 0) return values
  }
  const value = headers.authorization
  if (Array.isArray(value)) return [...value]
  return value === undefined ? [] : [value]
}

/** Parse one and only one Authorization header without normalizing token bytes. */
export function parseBearer(headers: BearerHeaders | IncomingHttpHeaders): string {
  if (Object.prototype.hasOwnProperty.call(headers, 'access_token')) throw new BearerError('请求不允许通过非 Authorization 位置传递凭证')
  const values = rawAuthorizationValues(headers)
  if (Array.isArray(headers.authorization) || values.length !== 1) throw new BearerError()
  const value = values[0]!
  if (/[\u0000-\u001f\u007f]/.test(value) || value.includes(',')) throw new BearerError('Bearer 凭证格式无效')
  const match = /^Bearer ([^\s,]+)$/.exec(value)
  if (!match || match[1].length === 0) throw new BearerError('Bearer 凭证格式无效')
  if (match[1].length > 512) throw new BearerError('Bearer 凭证过长')
  return match[1]
}
