import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { validateImageFile } from '../server/image-file.ts'

test('PNG magic bytes are accepted and SHA-256 uses the raw bytes', () => {
  const bytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
  const image = validateImageFile({ bytes, fileName: 'receipt.png', declaredMime: 'image/png', maxBytes: 5 * 1024 * 1024 })
  assert.equal(image.mimeType, 'image/png')
  assert.equal(image.extension, 'png')
  assert.equal(image.sha256, createHash('sha256').update(bytes).digest('hex'))
})

test('declared PNG with SVG content is rejected', () => {
  assert.throws(() => validateImageFile({
    bytes: Buffer.from('<svg></svg>'), fileName: 'unsafe.png', declaredMime: 'image/png', maxBytes: 1024
  }), /文件内容与图片类型不匹配/)
})

test('file name, declared MIME, extension, and magic bytes must agree', () => {
  const jpeg = Buffer.from('ffd8ffe000104a464946', 'hex')
  assert.throws(
    () => validateImageFile({ bytes: jpeg, fileName: 'wrong.png', declaredMime: 'image/jpeg', maxBytes: 1024 }),
    /扩展名与图片类型不匹配/
  )
  assert.throws(
    () => validateImageFile({ bytes: jpeg, fileName: '../receipt.jpg', declaredMime: 'image/jpeg', maxBytes: 1024 }),
    /文件名无效/
  )
})
