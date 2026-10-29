import assert from 'node:assert/strict'
import test from 'node:test'
import { assertScopedEntity, ownershipFrom, ScopeDeniedError, scopeFilter } from '../server/iam/data-scope.ts'

const base = (scope: { all: boolean; self: boolean; deptIds: string[] }, extra: Record<string, unknown> = {}) => ({
  accessToken: 'token', tenantId: '0', userId: '1001', clientId: 'crowdfunding' as const,
  scopes: ['openid'] as const, dataScope: scope, user: { id: '1001', username: 'u', nickname: 'U', deptId: '200' }, ...extra
})

test('scope filter truth table is tenant prefixed and context immutable', () => {
  const contexts = [
    [base({ all: true, self: false, deptIds: [] }), { tenantId: '0' }],
    [base({ all: false, self: true, deptIds: [] }), { tenantId: '0', ownerUserId: '1001' }],
    [base({ all: false, self: true, deptIds: ['200', '201'] }), { tenantId: '0', $or: [{ ownerUserId: '1001' }, { ownerDeptId: { $in: ['200', '201'] } }] }],
    [base({ all: false, self: false, deptIds: ['200'] }), { tenantId: '0', ownerDeptId: { $in: ['200'] } }],
    [base({ all: false, self: false, deptIds: [] }), { tenantId: '0', _scopeDenied: { $eq: true } }]
  ] as const
  for (const [context, expected] of contexts) assert.deepEqual(scopeFilter(context), expected)
  assert.equal((contexts[1]![0] as any).tenantId, '0')
})

test('ownership ignores request tenant and normalizes decimal ids', () => {
  const context = base({ all: false, self: true, deptIds: ['020'] }, { tenantId: '00', user: { id: '1001', username: 'u', nickname: 'U', deptId: '020' } })
  assert.deepEqual(ownershipFrom(context), { tenantId: '0', ownerUserId: '1001', ownerDeptId: '20' })
  assert.throws(() => ownershipFrom(base({ all: true, self: false, deptIds: [] }, { tenantId: '42' })), /租户/)
  assert.throws(() => ownershipFrom(base({ all: true, self: false, deptIds: [] }, { userId: '1e3' })), /十进制/)
})

test('assertScopedEntity hides cross tenant, owner, department, missing owner and deny-all entities as stable 404', () => {
  const context = base({ all: false, self: true, deptIds: ['200'] })
  for (const entity of [
    { tenantId: '1', ownerUserId: '1001' },
    { tenantId: '0', ownerUserId: '1002', ownerDeptId: '300' },
    { tenantId: '0', ownerUserId: '1002' },
    { tenantId: '0' },
  ]) assert.throws(() => assertScopedEntity(entity, context), (error: unknown) => error instanceof ScopeDeniedError && error.status === 404 && error.code === 'SCOPE_DENIED')
  assert.throws(() => assertScopedEntity({ tenantId: '0', ownerUserId: '1001' }, base({ all: false, self: false, deptIds: [] })), ScopeDeniedError)
  assert.doesNotThrow(() => assertScopedEntity({ tenantId: '0', ownerUserId: '1001' }, context))
  assert.doesNotThrow(() => assertScopedEntity({ tenantId: '0', ownerUserId: '999', ownerDeptId: '200' }, context))
})
