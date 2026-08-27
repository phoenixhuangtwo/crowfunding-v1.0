import assert from 'node:assert/strict'
import test from 'node:test'

test('settlement detail displays the real subscriber and payment time', async () => {
  let settlementSubscriberLabel: undefined | ((row: { userId?: string }, names: Record<string, string>) => string)
  let settlementPaymentTime: undefined | ((row: { paymentSuccessAt?: string; paymentUploadedAt?: string }) => string)

  try {
    ;({ settlementSubscriberLabel, settlementPaymentTime } = await import('../src/settlement-detail.ts'))
  } catch {
    // The assertions below record the missing production behavior as a normal test failure.
  }

  assert.equal(typeof settlementSubscriberLabel, 'function')
  assert.equal(typeof settlementPaymentTime, 'function')

  const names = { employee01: '张明' }
  assert.equal(settlementSubscriberLabel!({ userId: 'employee01' }, names), 'employee01 · 张明')
  assert.equal(settlementSubscriberLabel!({ userId: 'finance01' }, names), 'finance01')
  assert.equal(settlementSubscriberLabel!({}, names), '-')

  assert.equal(settlementPaymentTime!({
    paymentSuccessAt: '2026-08-25 17:54:20',
    paymentUploadedAt: '2026-08-25 17:53:58'
  }), '2026-08-25 17:54:20')
  assert.equal(settlementPaymentTime!({ paymentUploadedAt: '2026-08-25 17:53:58' }), '2026-08-25 17:53:58')
  assert.equal(settlementPaymentTime!({}), '-')
})
