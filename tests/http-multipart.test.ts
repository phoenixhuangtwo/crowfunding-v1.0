import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import type { IncomingMessage } from 'node:http'
import { readSingleImageMultipart } from '../server/http-multipart.ts'
import { readRawBody } from '../server/http-json-body.ts'

function request(body: Buffer, boundary: string) {
  const stream = Readable.from([body]) as IncomingMessage
  stream.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` }
  return stream
}

function multipart(boundary: string, fields: Array<[string, string]>, files: Array<{ name: string; bytes: Buffer }>) {
  const parts: Buffer[] = []
  for (const [name, value] of fields) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  }
  for (const file of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${file.name}"\r\nContent-Type: image/png\r\n\r\n`))
    parts.push(file.bytes, Buffer.from('\r\n'))
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`))
  return Buffer.concat(parts)
}

test('multipart parser returns one bounded in-memory image and approved fields', async () => {
  const boundary = 'safe-boundary'
  const png = Buffer.from('89504e470d0a1a0a', 'hex')
  const result = await readSingleImageMultipart(request(multipart(boundary, [['projectId', 'PRJ-1']], [{ name: 'receipt.png', bytes: png }]), boundary), {
    maxFileBytes: 1024,
    maxFieldBytes: 100,
    allowedFields: ['projectId']
  })
  assert.deepEqual(result.fields, { projectId: 'PRJ-1' })
  assert.deepEqual(result.file.bytes, png)
})

test('multipart parser rejects duplicate fields and multiple files', async () => {
  const boundary = 'safe-boundary'
  const png = Buffer.from('89504e470d0a1a0a', 'hex')
  await assert.rejects(
    () => readSingleImageMultipart(request(multipart(boundary, [['projectId', 'A'], ['projectId', 'B']], [{ name: 'a.png', bytes: png }]), boundary), {
      maxFileBytes: 1024, maxFieldBytes: 100, allowedFields: ['projectId']
    }),
    /重复字段/
  )
  await assert.rejects(
    () => readSingleImageMultipart(request(multipart(boundary, [], [{ name: 'a.png', bytes: png }, { name: 'b.png', bytes: png }]), boundary), {
      maxFileBytes: 1024, maxFieldBytes: 100, allowedFields: []
    }),
    /只能上传一个图片文件/
  )
})

test('multipart parser reuses the body buffered by authentication', async () => {
  const boundary = 'buffered-boundary'
  const png = Buffer.from('89504e470d0a1a0a', 'hex')
  const req = request(multipart(boundary, [], [{ name: 'payment.png', bytes: png }]), boundary)
  await readRawBody(req)
  const parsed = await readSingleImageMultipart(req, { maxFileBytes: 1024, maxFieldBytes: 100, allowedFields: [] })
  assert.deepEqual(parsed.file.bytes, png)
})
