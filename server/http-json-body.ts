export const DEFAULT_JSON_BODY_LIMIT = 8 * 1024 * 1024

type JsonBodyStream = AsyncIterable<Uint8Array | string> & {
  headers?: Record<string, string | string[] | undefined>
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

export async function readJsonBody(req: JsonBodyStream, maxBytes = DEFAULT_JSON_BODY_LIMIT) {
  const suppliedLength = req.headers?.['content-length']
  const contentLength = Array.isArray(suppliedLength) ? suppliedLength[0] : suppliedLength
  if (contentLength !== undefined) {
    const declaredBytes = Number(contentLength)
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
      throw new RequestBodyError('Content-Length 无效', 400, 'REQUEST_BODY_INVALID')
    }
    if (declaredBytes > maxBytes) {
      throw new RequestBodyError(`请求体不能超过 ${maxBytes} 字节`, 413, 'REQUEST_BODY_TOO_LARGE')
    }
  }

  const chunks: Buffer[] = []
  let receivedBytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    receivedBytes += buffer.length
    if (receivedBytes > maxBytes) {
      throw new RequestBodyError(`请求体不能超过 ${maxBytes} 字节`, 413, 'REQUEST_BODY_TOO_LARGE')
    }
    chunks.push(buffer)
  }

  const raw = Buffer.concat(chunks, receivedBytes).toString('utf8')
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('body must be an object')
    }
    return parsed as Record<string, unknown>
  } catch {
    throw new RequestBodyError('请求体必须是合法的 JSON 对象', 400, 'REQUEST_BODY_INVALID')
  }
}
