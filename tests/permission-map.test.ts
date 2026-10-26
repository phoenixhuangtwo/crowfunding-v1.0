import assert from 'node:assert/strict'
import test from 'node:test'
import { permissionFor, type ApiPermissionCode, reviewPermissionFor } from '../server/iam/permissions.ts'

test('maps every protected route to an exact permission', () => {
  const cases: Array<[string, string, ApiPermissionCode]> = [
    ['GET', '/api/auth/me', 'crowdfunding:access'],
    ['GET', '/api/state', 'crowdfunding:access'],
    ['GET', '/api/rbac', 'crowdfunding:access'],
    ['GET', '/api/agreements/current', 'crowdfunding:access'],
    ['GET', '/api/agreements', 'crowdfunding:agreement:manage'],
    ['GET', '/api/agreements/1/confirmations', 'crowdfunding:agreement:manage'],
    ['GET', '/api/projects', 'crowdfunding:project:query'],
    ['GET', '/api/projects/P1', 'crowdfunding:project:query'],
    ['GET', '/api/receiving-codes', 'crowdfunding:receiving-code:query'],
    ['GET', '/api/subscriptions', 'crowdfunding:subscription:query'],
    ['GET', '/api/rules', 'crowdfunding:rule:query'],
    ['GET', '/api/audit-logs', 'crowdfunding:audit:query'],
    ['GET', '/api/risk-events', 'crowdfunding:risk:query'],
    ['GET', '/api/procurement/orders/P1', 'crowdfunding:project:query'],
    ['GET', '/api/files/A1/content', 'crowdfunding:access'],
    ['POST', '/api/mcp/sync', 'crowdfunding:procurement:sync'],
    ['POST', '/api/agreements', 'crowdfunding:agreement:manage'],
    ['POST', '/api/agreements/confirm-view-code', 'crowdfunding:receiving-code:query'],
    ['POST', '/api/invoices/pending/delete', 'crowdfunding:settlement:upload-invoice'],
    ['POST', '/api/projects/P1/open', 'crowdfunding:project:open'],
    ['POST', '/api/projects/P1/terminate', 'crowdfunding:project:terminate'],
    ['POST', '/api/projects/P1/interrupt', 'crowdfunding:project:interrupt'],
    ['POST', '/api/subscriptions', 'crowdfunding:subscription:create'],
    ['POST', '/api/subscriptions/S1/confirm-receipt', 'crowdfunding:subscription:confirm-receipt'],
    ['POST', '/api/subscriptions/S1/review', 'crowdfunding:payment-review:query'],
    ['POST', '/api/payments/images/delete', 'crowdfunding:payment-proof:delete'],
    ['POST', '/api/payments/ocr', 'crowdfunding:payment-proof:ocr'],
    ['POST', '/api/invoices/ocr', 'crowdfunding:settlement:upload-invoice'],
    ['POST', '/api/settlements/calc', 'crowdfunding:settlement:calculate'],
    ['POST', '/api/projects/P1/settlements/confirm', 'crowdfunding:settlement:confirm'],
    ['POST', '/api/rules', 'crowdfunding:rule:create'],
    ['POST', '/api/rules/R1/update', 'crowdfunding:rule:update'],
    ['POST', '/api/rules/R1/status', 'crowdfunding:rule:change-status'],
    ['POST', '/api/rules/R1/delete', 'crowdfunding:rule:delete'],
    ['POST', '/api/receiving-codes', 'crowdfunding:receiving-code:create'],
    ['POST', '/api/receiving-codes/R1/image', 'crowdfunding:receiving-code:update-image'],
    ['POST', '/api/receiving-codes/R1/disable', 'crowdfunding:receiving-code:disable'],
    ['POST', '/api/receiving-codes/R1/enable', 'crowdfunding:receiving-code:disable'],
    ['POST', '/api/takeovers/P1/force', 'crowdfunding:takeover:force']
  ]
  for (const [method, path, expected] of cases) assert.equal(permissionFor(method, path), expected, `${method} ${path}`)
})

test('does not silently permit unregistered routes', () => {
  assert.throws(() => permissionFor('GET', '/api/agreements/word/confirmations'), /未登记权限/)
  assert.throws(() => permissionFor('GET', '/api/projects/P1/unknown'), /未登记权限/)
})

test('validates one payment-review action and maps its purpose-specific code', () => {
  assert.equal(reviewPermissionFor('approve'), 'crowdfunding:payment-review:approve')
  assert.equal(reviewPermissionFor('reject'), 'crowdfunding:payment-review:reject')
  assert.equal(reviewPermissionFor('partial'), 'crowdfunding:payment-review:partial')
  assert.equal(reviewPermissionFor('通过'), 'crowdfunding:payment-review:approve')
  assert.throws(() => reviewPermissionFor('approve,reject'), /复核动作无效/)
  assert.throws(() => reviewPermissionFor('other'), /复核动作无效/)
})
