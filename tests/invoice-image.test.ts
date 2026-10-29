import assert from 'node:assert/strict'
import test from 'node:test'

test('invoice preview accepts supported images and rejects invalid files before reading', async () => {
  let validateInvoiceImage: undefined | ((file: { type: string; size: number }) => string | undefined)

  try {
    ;({ validateInvoiceImage } = await import('../src/invoice-image.ts'))
  } catch {
    // The assertion below records the missing production behavior as a normal test failure.
  }

  assert.equal(typeof validateInvoiceImage, 'function')
  assert.equal(validateInvoiceImage!({ type: 'image/png', size: 1024 }), undefined)
  assert.equal(validateInvoiceImage!({ type: 'image/jpeg', size: 5 * 1024 * 1024 }), undefined)
  assert.equal(validateInvoiceImage!({ type: 'image/bmp', size: 1024 }), undefined)
  assert.equal(validateInvoiceImage!({ type: 'image/webp', size: 1024 }), '发票识别仅支持 PNG、JPG、JPEG 或 BMP 图片')
  assert.equal(validateInvoiceImage!({ type: 'image/bmp', size: 5 * 1024 * 1024 + 1 }), '发票图片大小不能超过 5MB')
})
