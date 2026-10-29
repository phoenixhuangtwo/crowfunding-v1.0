import assert from 'node:assert/strict'
import test from 'node:test'

test('invoice upload becomes available only after settlement confirmation resolves', async () => {
  let beginSettlement: undefined | ((confirm: () => Promise<unknown>) => Promise<boolean>)
  try {
    ;({ beginSettlement } = await import('../src/settlement-flow.ts'))
  } catch {
    // The assertion below records the missing production behavior as a normal test failure.
  }

  assert.equal(typeof beginSettlement, 'function', 'settlement flow needs an explicit confirmation gate')
  assert.equal(await beginSettlement!(() => Promise.resolve('confirmed')), true)
  await assert.rejects(() => beginSettlement!(() => Promise.reject(new Error('cancelled'))), /cancelled/)
})
