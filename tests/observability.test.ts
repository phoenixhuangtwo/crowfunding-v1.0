import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { currentRequestId, observeRequests, traceOperation } from '../server/observability.ts'

test('concurrent requests correlate dependencies, return IDs, and omit sensitive data', async () => {
  const lines: string[] = []
  const original = console.log
  console.log = value => { lines.push(String(value)) }
  const server = createServer(observeRequests(async (req, res) => {
    try {
      await traceOperation('ocr', 'recognize', async () => {
        await new Promise(resolve => setTimeout(resolve, req.url?.includes('first') ? 15 : 1))
        if (req.url?.includes('second')) throw new Error('SECRET_BODY_TOKEN')
      })
      res.end(currentRequestId())
    } catch {
      res.statusCode = 500
      res.end(currentRequestId())
    }
  }))
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address() as { port: number }
    const results = await Promise.all(['first', 'second'].map(async id => {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/files/${id}/content?token=SECRET_QUERY`, { headers: { authorization: 'SECRET_HEADER', 'X-Request-Id': 'UNTRUSTED_ID' } })
      assert.equal(await response.text(), response.headers.get('x-request-id'))
      return response.headers.get('x-request-id')
    }))
    assert.notEqual(results[0], results[1])
    const records = lines.map(line => JSON.parse(line))
    for (const id of results) {
      assert.equal(records.filter(row => row.event === 'http.request' && row.requestId === id).length, 1)
      assert.equal(records.filter(row => row.event === 'dependency.complete' && row.requestId === id).length, 1)
    }
    assert.equal(records.find(row => row.event === 'dependency.error').requestId, results[1])
    assert.equal(records.filter(row => row.event === 'http.request').every(row => row.route === '/api/files/:id/content'), true)
    assert.doesNotMatch(lines.join('\n'), /SECRET_|UNTRUSTED_ID/)
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    console.log = original
  }
})
