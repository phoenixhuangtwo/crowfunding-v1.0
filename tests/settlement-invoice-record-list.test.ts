import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

test('settlement page keeps subscriptions before upload and places confirmed recognition records last', async () => {
  const source = await readFile(resolve('src/App.vue'), 'utf8')
  const tableIndex = source.indexOf('data-testid="settlement-subscription-table"')
  const uploadIndex = source.indexOf('data-testid="settlement-invoice-upload"')
  const recordsIndex = source.indexOf('data-testid="settlement-invoice-records"')

  assert.notEqual(tableIndex, -1, 'settlement subscription table marker should exist')
  assert.notEqual(uploadIndex, -1, 'settlement invoice upload marker should exist')
  assert.notEqual(recordsIndex, -1, 'settlement invoice record list marker should exist')
  assert.ok(tableIndex < uploadIndex, 'subscription details should appear before invoice upload')
  assert.ok(uploadIndex < recordsIndex, 'confirmed recognition records should appear after invoice upload')
  assert.match(source.slice(recordsIndex), /selectedProject\.settlementInvoices/)
})
