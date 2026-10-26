import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'

const allowedMethods = ['GET', 'POST', 'OPTIONS'] as const
const allowedRequestHeaders = ['content-type', 'authorization'] as const

function rawHeaderValues(req: IncomingMessage, name: string): string[] {
  const values: string[] = []
  const lower = name.toLowerCase()
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === lower) values.push(req.rawHeaders[index + 1] ?? '')
  }
  if (values.length > 0) return values
  const value = req.headers[lower]
  if (Array.isArray(value)) return [...value]
  return value === undefined ? [] : [value]
}

function exactOrigin(req: IncomingMessage, allowedOrigin: string): boolean {
  const values = rawHeaderValues(req, 'origin')
  return values.length === 1 && values[0] === allowedOrigin
}

export function corsHeaders(req: IncomingMessage, allowedOrigin: string): OutgoingHttpHeaders {
  if (!exactOrigin(req, allowedOrigin)) return {}
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin'
  }
}

function cookiesHeaders(cookies: readonly string[] | undefined): OutgoingHttpHeaders {
  return cookies && cookies.length > 0 ? { 'Set-Cookie': [...cookies] } : {}
}

export function sendJson(
  req: IncomingMessage,
  res: ServerResponse,
  allowedOrigin: string,
  status: number,
  payload: unknown,
  cookies?: readonly string[],
  headers: OutgoingHttpHeaders = {}
): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    ...corsHeaders(req, allowedOrigin),
    ...headers,
    ...cookiesHeaders(cookies),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}

export function sendRedirect(
  req: IncomingMessage,
  res: ServerResponse,
  allowedOrigin: string,
  location: string,
  cookies?: readonly string[]
): void {
  res.writeHead(302, {
    ...corsHeaders(req, allowedOrigin),
    ...cookiesHeaders(cookies),
    Location: location,
    'Content-Length': '0'
  })
  res.end()
}

export function sendNoContent(
  req: IncomingMessage,
  res: ServerResponse,
  allowedOrigin: string,
  status: 204,
  cookies?: readonly string[]
): void {
  res.writeHead(status, {
    ...corsHeaders(req, allowedOrigin),
    ...cookiesHeaders(cookies)
  })
  res.end()
}

function denyPreflight(res: ServerResponse): void {
  const body = JSON.stringify({ error: 'CORS_FORBIDDEN', message: 'CORS 预检请求被拒绝' })
  res.writeHead(403, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  })
  res.end(body)
}

export function handleCorsPreflight(req: IncomingMessage, res: ServerResponse, allowedOrigin: string): boolean {
  if (req.method !== 'OPTIONS') return false
  const origins = rawHeaderValues(req, 'origin')
  const requestedMethods = rawHeaderValues(req, 'access-control-request-method')
  const requestedHeadersFields = rawHeaderValues(req, 'access-control-request-headers')
  if (origins.length !== 1 || origins[0] !== allowedOrigin || requestedMethods.length !== 1) {
    denyPreflight(res)
    return true
  }
  const requestedMethod = requestedMethods[0]?.trim().toUpperCase()
  if (!requestedMethod || !allowedMethods.includes(requestedMethod as typeof allowedMethods[number])) {
    denyPreflight(res)
    return true
  }
  if (requestedHeadersFields.length > 1) {
    denyPreflight(res)
    return true
  }
  const requestedHeaders = (requestedHeadersFields[0] ?? '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
  if (requestedHeaders.some(value => !allowedRequestHeaders.includes(value as typeof allowedRequestHeaders[number]))) {
    denyPreflight(res)
    return true
  }
  res.writeHead(204, {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    Vary: 'Origin'
  })
  res.end()
  return true
}
