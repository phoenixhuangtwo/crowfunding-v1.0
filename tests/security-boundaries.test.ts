import assert from 'node:assert/strict'
import test from 'node:test'
import { readJsonBody, RequestBodyError } from '../server/http-json-body.ts'
import { OcrProofStore } from '../server/ocr-proof.ts'
import { hasImageStorageCapacity, SlidingWindowQuota, ResourceLimitError } from '../server/resource-limits.ts'

function requestBody(chunks: string[], contentLength?: string) {
  return {
    headers: contentLength ? { 'content-length': contentLength } : {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield Buffer.from(chunk)
    }
  }
}

test('JSON body reader rejects declared and streamed bodies above the limit before parsing', async () => {
  await assert.rejects(
    readJsonBody(requestBody(['{}'], '11'), 10),
    error => error instanceof RequestBodyError && error.status === 413
  )
  await assert.rejects(
    readJsonBody(requestBody(['{"value":', '"too large"}']), 10),
    error => error instanceof RequestBodyError && error.status === 413
  )
})

test('JSON body reader preserves legitimate JSON behavior', async () => {
  assert.deepEqual(await readJsonBody(requestBody(['{"value":', '42}']), 1024), { value: 42 })
  assert.deepEqual(await readJsonBody(requestBody([]), 1024), {})
})

test('OCR proof binds project, file and image digest and can only be consumed once', () => {
  let now = 1_000
  const store = new OcrProofStore({
    now: () => now,
    idFactory: () => 'proof-1',
    ttlMs: 10_000,
    maxEntries: 5,
    maxEntriesPerProject: 2
  })
  const created = store.create({
    projectId: 'project-1',
    assetId: 'asset-1',
    imageDigest: 'a'.repeat(64),
    fileName: 'invoice.png',
    result: {
      amount: 520,
      taskNo: 'upstream-task',
      fields: [{ key: 'payer', label: '付款人', value: '示例公司' }]
    }
  })

  assert.equal(created.proofId, 'proof-1')
  assert.throws(() => store.consume({
    proofId: created.proofId,
    projectId: 'project-2',
    assetId: 'asset-1',
    imageDigest: 'a'.repeat(64),
    fileName: 'invoice.png'
  }), /OCR 凭证与当前项目不匹配/)

  const trusted = store.consume({
    proofId: created.proofId,
    projectId: 'project-1',
    assetId: 'asset-1',
    imageDigest: 'a'.repeat(64),
    fileName: 'invoice.png'
  })
  assert.equal(trusted.result.amount, 520)
  assert.throws(() => store.consume({
    proofId: created.proofId,
    projectId: 'project-1',
    assetId: 'asset-1',
    imageDigest: 'a'.repeat(64),
    fileName: 'invoice.png'
  }), /OCR 凭证不存在或已使用/)

  now += 20_000
})

test('OCR proof rejects a modified image without consuming the legitimate proof', () => {
  const store = new OcrProofStore({ idFactory: () => 'proof-2' })
  const created = store.create({
    projectId: 'project-1',
    assetId: 'asset-1',
    imageDigest: 'a'.repeat(64),
    fileName: 'invoice.png',
    result: { amount: 100, fields: [] }
  })
  assert.throws(() => store.consume({
    proofId: created.proofId,
    projectId: 'project-1',
    assetId: 'asset-2',
    imageDigest: 'b'.repeat(64),
    fileName: 'invoice.png'
  }), /OCR 凭证与上传图片不匹配/)
  assert.equal(store.consume({
    proofId: created.proofId,
    projectId: 'project-1',
    assetId: 'asset-1',
    imageDigest: 'a'.repeat(64),
    fileName: 'invoice.png'
  }).result.amount, 100)
})

test('sliding-window quota rejects calls above the configured budget and recovers after the window', () => {
  let now = 1_000
  const quota = new SlidingWindowQuota({ limit: 2, windowMs: 1_000, now: () => now })
  quota.take('ocr')
  quota.take('ocr')
  assert.throws(() => quota.take('ocr'), error => error instanceof ResourceLimitError && error.status === 429)
  now += 1_001
  assert.doesNotThrow(() => quota.take('ocr'))
})

test('image storage capacity accounts for replacement without allowing aggregate growth past the cap', () => {
  assert.equal(hasImageStorageCapacity(900, 200, 250, 1000), true)
  assert.equal(hasImageStorageCapacity(900, 0, 101, 1000), false)
  assert.equal(hasImageStorageCapacity(900, 200, 250 * 2, 1000), false)
})
