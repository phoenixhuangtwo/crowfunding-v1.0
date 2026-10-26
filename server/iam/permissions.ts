export const API_PERMISSION_CODES = [
  'crowdfunding:access', 'crowdfunding:project:query', 'crowdfunding:subscription:query',
  'crowdfunding:payment-proof:query', 'crowdfunding:rule:query', 'crowdfunding:receiving-code:query',
  'crowdfunding:payment-review:query', 'crowdfunding:settlement:query', 'crowdfunding:takeover:query',
  'crowdfunding:audit:query', 'crowdfunding:risk:query', 'crowdfunding:procurement:sync',
  'crowdfunding:agreement:manage',
  'crowdfunding:project:open', 'crowdfunding:project:terminate', 'crowdfunding:project:interrupt',
  'crowdfunding:subscription:create', 'crowdfunding:subscription:confirm-receipt',
  'crowdfunding:payment-proof:upload', 'crowdfunding:payment-proof:delete', 'crowdfunding:payment-proof:ocr',
  'crowdfunding:rule:create', 'crowdfunding:rule:update', 'crowdfunding:rule:change-status',
  'crowdfunding:rule:delete', 'crowdfunding:receiving-code:create', 'crowdfunding:receiving-code:update-image',
  'crowdfunding:receiving-code:disable', 'crowdfunding:payment-review:approve',
  'crowdfunding:payment-review:reject', 'crowdfunding:payment-review:partial',
  'crowdfunding:settlement:calculate', 'crowdfunding:settlement:confirm',
  'crowdfunding:settlement:upload-invoice', 'crowdfunding:takeover:force'
] as const

export type ApiPermissionCode = typeof API_PERMISSION_CODES[number]
export class UnregisteredPermissionError extends Error {
  constructor(method: string, pathname: string) {
    super(`未登记权限：${method.toUpperCase()} ${pathname}`)
    this.name = 'UnregisteredPermissionError'
  }
}

const id = '[^/]+'
const routes: Array<[string, RegExp, ApiPermissionCode]> = [
  ['GET', /^\/api\/auth\/me$/, 'crowdfunding:access'],
  ['GET', /^\/api\/state$/, 'crowdfunding:access'],
  ['GET', /^\/api\/rbac$/, 'crowdfunding:access'],
  ['GET', /^\/api\/agreements\/current$/, 'crowdfunding:access'],
  ['GET', /^\/api\/agreements$/, 'crowdfunding:agreement:manage'],
  ['GET', /^\/api\/agreements\/\d+\/confirmations$/, 'crowdfunding:agreement:manage'],
  ['GET', /^\/api\/projects$/, 'crowdfunding:project:query'],
  ['GET', new RegExp(`^\\/api\\/projects\\/${id}$`), 'crowdfunding:project:query'],
  ['GET', /^\/api\/receiving-codes$/, 'crowdfunding:receiving-code:query'],
  ['GET', /^\/api\/subscriptions$/, 'crowdfunding:subscription:query'],
  ['GET', /^\/api\/rules$/, 'crowdfunding:rule:query'],
  ['GET', /^\/api\/audit-logs$/, 'crowdfunding:audit:query'],
  ['GET', /^\/api\/risk-events$/, 'crowdfunding:risk:query'],
  ['GET', new RegExp(`^\\/api\\/procurement\\/orders\\/${id}$`), 'crowdfunding:project:query'],
  ['GET', new RegExp(`^\\/api\\/files\\/${id}\\/content$`), 'crowdfunding:access'],
  ['POST', /^\/api\/mcp\/sync$/, 'crowdfunding:procurement:sync'],
  ['POST', /^\/api\/agreements$/, 'crowdfunding:agreement:manage'],
  ['POST', /^\/api\/agreements\/confirm-view-code$/, 'crowdfunding:receiving-code:query'],
  ['POST', /^\/api\/invoices\/pending\/delete$/, 'crowdfunding:settlement:upload-invoice'],
  ['POST', new RegExp(`^\\/api\\/projects\\/${id}\\/open$`), 'crowdfunding:project:open'],
  ['POST', new RegExp(`^\\/api\\/projects\\/${id}\\/terminate$`), 'crowdfunding:project:terminate'],
  ['POST', new RegExp(`^\\/api\\/projects\\/${id}\\/interrupt$`), 'crowdfunding:project:interrupt'],
  ['POST', /^\/api\/subscriptions$/, 'crowdfunding:subscription:create'],
  ['POST', new RegExp(`^\\/api\\/subscriptions\\/${id}\\/confirm-receipt$`), 'crowdfunding:subscription:confirm-receipt'],
  ['POST', new RegExp(`^\\/api\\/subscriptions\\/${id}\\/review$`), 'crowdfunding:payment-review:query'],
  ['POST', /^\/api\/payments\/images\/delete$/, 'crowdfunding:payment-proof:delete'],
  ['POST', /^\/api\/payments\/ocr$/, 'crowdfunding:payment-proof:ocr'],
  ['POST', /^\/api\/invoices\/ocr$/, 'crowdfunding:settlement:upload-invoice'],
  ['POST', /^\/api\/settlements\/calc$/, 'crowdfunding:settlement:calculate'],
  ['POST', new RegExp(`^\\/api\\/projects\\/${id}\\/settlements\\/confirm$`), 'crowdfunding:settlement:confirm'],
  ['POST', /^\/api\/rules$/, 'crowdfunding:rule:create'],
  ['POST', new RegExp(`^\\/api\\/rules\\/${id}\\/update$`), 'crowdfunding:rule:update'],
  ['POST', new RegExp(`^\\/api\\/rules\\/${id}\\/status$`), 'crowdfunding:rule:change-status'],
  ['POST', new RegExp(`^\\/api\\/rules\\/${id}\\/delete$`), 'crowdfunding:rule:delete'],
  ['POST', /^\/api\/receiving-codes$/, 'crowdfunding:receiving-code:create'],
  ['POST', new RegExp(`^\\/api\\/receiving-codes\\/${id}\\/image$`), 'crowdfunding:receiving-code:update-image'],
  ['POST', new RegExp(`^\\/api\\/receiving-codes\\/${id}\\/disable$`), 'crowdfunding:receiving-code:disable'],
  ['POST', new RegExp(`^\\/api\\/receiving-codes\\/${id}\\/enable$`), 'crowdfunding:receiving-code:disable'],
  ['POST', new RegExp(`^\\/api\\/takeovers\\/${id}\\/force$`), 'crowdfunding:takeover:force']
]

export function permissionFor(method: string, pathname: string): ApiPermissionCode {
  const normalizedMethod = method.toUpperCase()
  const found = routes.find(([verb, pattern]) => verb === normalizedMethod && pattern.test(pathname))
  if (!found) throw new UnregisteredPermissionError(normalizedMethod, pathname)
  return found[2]
}

const reviewCodes = {
  approve: 'crowdfunding:payment-review:approve',
  reject: 'crowdfunding:payment-review:reject',
  partial: 'crowdfunding:payment-review:partial',
  pass: 'crowdfunding:payment-review:approve',
  通过: 'crowdfunding:payment-review:approve',
  驳回: 'crowdfunding:payment-review:reject',
  部分: 'crowdfunding:payment-review:partial'
} as const
export type ReviewAction = keyof typeof reviewCodes
export function reviewPermissionFor(action: unknown): ApiPermissionCode {
  if (typeof action !== 'string' || action.trim() !== action || !(action in reviewCodes)) throw new Error('复核动作无效')
  return reviewCodes[action as ReviewAction]
}
