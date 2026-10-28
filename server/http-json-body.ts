import JSONBig from 'json-bigint'

const businessJson = JSONBig({ strict: true, useNativeBigInt: true })

export const DEFAULT_JSON_BODY_LIMIT = 8 * 1024 * 1024

type JsonBodyStream = AsyncIterable<Uint8Array | string> & {
  headers?: Record<string, string | string[] | undefined>
  body?: Record<string, unknown>
  rawBody?: Buffer
}

export class RequestBodyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413,
    readonly code: 'REQUEST_BODY_INVALID' | 'REQUEST_BODY_TOO_LARGE'
  ) {
    super(message)
  }
}

export async function readRawBody(req: JsonBodyStream, maxBytes = DEFAULT_JSON_BODY_LIMIT): Promise<Buffer> {
  if (req.rawBody) return req.rawBody
  const suppliedLength = req.headers?.['content-length']
  const contentLength = Array.isArray(suppliedLength) ? suppliedLength[0] : suppliedLength
  if (contentLength !== undefined) {
    const declaredBytes = Number(contentLength)
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) throw new RequestBodyError('Content-Length 无效', 400, 'REQUEST_BODY_INVALID')
    if (declaredBytes > maxBytes) throw new RequestBodyError(`请求体不能超过 ${maxBytes} 字节`, 413, 'REQUEST_BODY_TOO_LARGE')
  }
  const chunks: Buffer[] = []
  let receivedBytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    receivedBytes += buffer.length
    if (receivedBytes > maxBytes) throw new RequestBodyError(`请求体不能超过 ${maxBytes} 字节`, 413, 'REQUEST_BODY_TOO_LARGE')
    chunks.push(buffer)
  }
  req.rawBody = Buffer.concat(chunks, receivedBytes)
  return req.rawBody
}

class JsonKeyScanner {
  private index = 0
  constructor(private readonly text: string) {}
  scan() { this.value(); this.ws(); if (this.index !== this.text.length) throw new Error('trailing JSON') }
  private ws() { while (/\s/.test(this.text[this.index] ?? '')) this.index += 1 }
  private value() {
    this.ws()
    const char = this.text[this.index]
    if (char === '{') return this.object()
    if (char === '[') return this.array()
    if (char === '"') { this.string(); return }
    const start = this.index
    while (this.index < this.text.length && !/\s|[,\]}]/.test(this.text[this.index]!)) this.index += 1
    if (start === this.index) throw new Error('missing JSON value')
    JSON.parse(this.text.slice(start, this.index))
  }
  private string(): string {
    const start = this.index
    if (this.text[this.index] !== '"') throw new Error('string expected')
    this.index += 1
    let escaped = false
    while (this.index < this.text.length) {
      const char = this.text[this.index++]!
      if (escaped) { escaped = false; continue }
      if (char === '\\') { escaped = true; continue }
      if (char === '"') return JSON.parse(this.text.slice(start, this.index)) as string
      if (char < ' ') throw new Error('control in string')
    }
    throw new Error('unterminated string')
  }
  private object() {
    this.index += 1; this.ws()
    const keys = new Set<string>()
    if (this.text[this.index] === '}') { this.index += 1; return }
    while (true) {
      this.ws(); const key = this.string()
      if (keys.has(key)) throw new Error('duplicate JSON key')
      keys.add(key); this.ws()
      if (this.text[this.index++] !== ':') throw new Error('colon expected')
      this.value(); this.ws()
      const delimiter = this.text[this.index++]
      if (delimiter === '}') return
      if (delimiter !== ',') throw new Error('object delimiter expected')
    }
  }
  private array() {
    this.index += 1; this.ws()
    if (this.text[this.index] === ']') { this.index += 1; return }
    while (true) {
      this.value(); this.ws()
      const delimiter = this.text[this.index++]
      if (delimiter === ']') return
      if (delimiter !== ',') throw new Error('array delimiter expected')
    }
  }
}

function parseStrictJson(raw: string): unknown {
  new JsonKeyScanner(raw).scan()
  return businessJson.parse(raw)
}

function businessValue(value: unknown): unknown {
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value
  if (Array.isArray(value)) return value.map(businessValue)
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) output[key] = businessValue(child)
    return output
  }
  return value
}

function containsAccessToken(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(containsAccessToken)
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => key === 'access_token' || containsAccessToken(child))
}

const dispositionToken = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
// Header text is held as latin1 so arbitrary file bytes remain lossless; reject
// mandatory C0/DEL controls without mistaking UTF-8 filename bytes for C1 chars.
const dispositionControl = /[\u0000-\u001f\u007f]/

function parseDisposition(disposition: string): { fieldName: string; filename?: string } | null {
  const prefix = /^content-disposition\s*:\s*form-data\b/i.exec(disposition)
  if (!prefix) return null
  const params: Record<string, string> = {}
  let index = prefix[0].length
  while (index < disposition.length) {
    while (/\s/.test(disposition[index] ?? '')) index += 1
    if (index >= disposition.length) break
    if (disposition[index] !== ';') return null
    index += 1
    while (/\s/.test(disposition[index] ?? '')) index += 1
    const keyStart = index
    while (index < disposition.length && /[!#$%&'*+.^_`|~0-9A-Za-z-]/.test(disposition[index])) index += 1
    if (keyStart === index) return null
    const key = disposition.slice(keyStart, index).toLowerCase()
    if (key !== 'name' && key !== 'filename') return null
    if (params[key] !== undefined) return null
    while (/\s/.test(disposition[index] ?? '')) index += 1
    if (disposition[index] !== '=') return null
    index += 1
    while (/\s/.test(disposition[index] ?? '')) index += 1
    let value = ''
    if (disposition[index] === '"') {
      index += 1
      let closed = false
      while (index < disposition.length) {
        const char = disposition[index++]
        if (char === '"') {
          closed = true
          break
        }
        if (dispositionControl.test(char)) return null
        if (char === '\\') {
          if (index >= disposition.length) return null
          const escaped = disposition[index++]
          if (dispositionControl.test(escaped)) return null
          value += escaped
        } else {
          value += char
        }
      }
      if (!closed) return null
      while (/\s/.test(disposition[index] ?? '')) index += 1
      if (index < disposition.length && disposition[index] !== ';') return null
    } else {
      const valueStart = index
      while (index < disposition.length && disposition[index] !== ';' && !/\s/.test(disposition[index])) index += 1
      if (valueStart === index || !dispositionToken.test(disposition.slice(valueStart, index))) return null
      value = disposition.slice(valueStart, index)
      while (/\s/.test(disposition[index] ?? '')) index += 1
      if (index < disposition.length && disposition[index] !== ';') return null
    }
    params[key] = value
  }
  if (params.name === undefined || params.name.length === 0) return null
  return { fieldName: params.name, ...(params.filename !== undefined ? { filename: params.filename } : {}) }
}

export function bodyContainsAccessToken(raw: Buffer, contentType = ''): boolean {
  const lowerType = contentType.toLowerCase()
  if (lowerType.startsWith('multipart/form-data;')) {
    const boundary = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)?.[1] ?? /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType)?.[2]
    if (!boundary) return true
    const text = raw.toString('latin1')
    for (const rawPart of text.split(`--${boundary}`).slice(1)) {
      if (rawPart.startsWith('--')) break
      const part = rawPart.replace(/^\r?\n/, '')
      const separator = part.indexOf('\r\n\r\n') >= 0 ? part.indexOf('\r\n\r\n') : part.indexOf('\n\n')
      if (separator < 0) return true
      const headers = part.slice(0, separator)
      if (!/content-disposition\s*:/i.test(headers)) return true
      const disposition = /content-disposition:[^\r\n]*/i.exec(headers)?.[0] ?? ''
      const parsedDisposition = parseDisposition(disposition)
      if (!parsedDisposition) return true
      const { fieldName } = parsedDisposition
      const isFile = parsedDisposition.filename !== undefined
      if (fieldName === 'access_token') return true
      if (isFile) continue
      const valueStart = separator + (part.slice(separator).startsWith('\r\n\r\n') ? 4 : 2)
      const value = part.slice(valueStart).replace(/\r?\n$/, '')
      const trimmedValue = value.trim()
      if (/^[\[{]/.test(trimmedValue)) {
        try {
          if (containsAccessToken(parseStrictJson(value))) return true
        } catch {
          return true
        }
      }
      if (/access_token/i.test(value)) return true
    }
    return false
  }
  try { return containsAccessToken(parseStrictJson(raw.toString('utf8'))) } catch { return false }
}

export async function readJsonBody(req: JsonBodyStream, maxBytes = DEFAULT_JSON_BODY_LIMIT) {
  if (req.body !== undefined) return req.body
  const raw = (await readRawBody(req, maxBytes)).toString('utf8')
  if (!raw) {
    req.body = {}
    return req.body
  }
  try {
    const parsed: unknown = businessValue(parseStrictJson(raw))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('body must be an object')
    }
    req.body = parsed as Record<string, unknown>
    return req.body
  } catch {
    throw new RequestBodyError('请求体必须是合法的 JSON 对象', 400, 'REQUEST_BODY_INVALID')
  }
}
