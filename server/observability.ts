import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

const context = new AsyncLocalStorage<{ requestId: string }>()
export const currentRequestId = () => context.getStore()?.requestId

// Only fixed metadata is logged: never headers, query strings, bodies or error messages.
export function logEvent(event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, requestId: currentRequestId(), ...fields }))
}

export function logFailure(event: string, error: unknown) {
  logEvent(event, {
    errorType: error instanceof Error ? error.constructor.name : 'UnknownError',
    stack: error instanceof Error ? error.stack?.split('\n').filter(line => /^\s+at /.test(line)).slice(0, 12) : undefined
  })
}

export async function traceOperation<T>(dependency: string, operation: string, work: () => Promise<T>): Promise<T> {
  const start = performance.now()
  try {
    const result = await work()
    logEvent('dependency.complete', { dependency, operation, outcome: 'success', durationMs: Math.round(performance.now() - start) })
    return result
  } catch (error) {
    logEvent('dependency.complete', { dependency, operation, outcome: 'failure', durationMs: Math.round(performance.now() - start) })
    logFailure('dependency.error', error)
    throw error
  }
}

export function observeRequests(handler: (req: IncomingMessage, res: ServerResponse) => Promise<unknown>) {
  return (req: IncomingMessage, res: ServerResponse) => context.run({ requestId: randomUUID() }, async () => {
    const start = performance.now()
    const requestId = currentRequestId()
    res.setHeader('X-Request-Id', requestId!)
    const path = (req.url ?? '/').split('?')[0]
    const segments = new Set(['api', 'health', 'state', 'files', 'content', 'projects', 'subscriptions', 'audit-logs', 'risk-events', 'rbac', 'procurement', 'orders', 'rules', 'receiving-codes', 'payments', 'invoices', 'ocr', 'mcp', 'sync', 'confirm-receipt', 'review', 'open', 'terminate', 'interrupt', 'image', 'disable', 'update', 'status', 'delete', 'images', 'settlements', 'calc', 'confirm', 'takeovers', 'force'])
    const route = path.split('/').map(segment => !segment || segments.has(segment) ? segment : ':id').join('/')
    let completed = false
    const finish = (outcome: string) => {
      if (completed) return
      completed = true
      logEvent('http.request', { requestId, method: req.method, route, status: res.statusCode, outcome, durationMs: Math.round(performance.now() - start) })
    }
    res.once('finish', () => finish('complete'))
    res.once('close', () => finish(res.writableFinished ? 'complete' : 'aborted'))
    return handler(req, res)
  })
}
