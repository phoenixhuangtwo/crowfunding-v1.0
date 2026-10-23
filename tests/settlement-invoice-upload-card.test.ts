import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('pending settlement invoice uses one card for upload, preview, replace, and delete', async () => {
  const source = await readFile(new URL('../src/App.vue', import.meta.url), 'utf8')
  const uploadIndex = source.indexOf('data-testid="settlement-invoice-upload-card"')
  const recordsIndex = source.indexOf('data-testid="settlement-invoice-records"')

  assert.notEqual(uploadIndex, -1, 'merged invoice upload card should exist')
  assert.ok(recordsIndex > uploadIndex, 'confirmed invoice records should remain after the pending upload card')

  const pendingUploadSource = source.slice(uploadIndex, recordsIndex)
  assert.match(pendingUploadSource, /v-if="!invoiceImageUrl"/)
  assert.match(pendingUploadSource, /class="invoice-upload-card__preview"/)
  assert.match(pendingUploadSource, /@click\.stop="openInvoicePreview"[^>]*>预览</)
  assert.match(pendingUploadSource, />重新上传</)
  assert.match(pendingUploadSource, /@click\.stop="removePendingInvoice"[^>]*>删除</)
  assert.doesNotMatch(source.slice(recordsIndex), /removePendingInvoice/)
})

test('deleting a pending invoice invalidates in-flight OCR and clears transient recognition state', async () => {
  const source = await readFile(new URL('../src/App.vue', import.meta.url), 'utf8')
  const resetIndex = source.indexOf('async function removePendingInvoice()')
  const confirmIndex = source.indexOf('async function confirmSettlementInvoice()')

  assert.notEqual(resetIndex, -1, 'pending invoice delete handler should exist')
  assert.ok(confirmIndex > resetIndex)

  const deleteHandler = source.slice(resetIndex, confirmIndex)
  assert.match(deleteHandler, /invoiceOcrRequestId\.value \+= 1/)
  assert.match(deleteHandler, /discardPendingInvoice\(result, projectId\)/)
  assert.match(deleteHandler, /resetInvoiceRecognition\(\)/)
})
