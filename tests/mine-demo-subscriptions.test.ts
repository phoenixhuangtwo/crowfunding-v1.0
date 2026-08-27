import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const targetProjectId = 'PRJ-FSY-OFFLINE-368'

test('default subscription fixtures contain ten unpaid demo rows and no paid demo rows', async () => {
  const serverSource = await readFile(new URL('../server/server.ts', import.meta.url), 'utf8')
  const unpaidIds = serverSource.match(/id: 'SUB-MOCK-WJK-\d{3}'/g) ?? []

  assert.equal(unpaidIds.length, 10)
  assert.doesNotMatch(serverSource, /id: 'SUB-MOCK-YJK-\d{3}'/)
})

test('current state migrates target payments to review and keeps all ten mutable payment demos', async () => {
  const state = JSON.parse(await readFile(new URL('../data/dev-state.json', import.meta.url), 'utf8'))
  const subscriptions = state.subscriptions as Array<{
    id: string
    projectId?: string
    pay?: string
    paymentUploadedAt?: string
    paymentImages?: unknown[]
  }>
  const targetPayments = subscriptions.filter(item => item.projectId === targetProjectId && item.pay === '待复核')
  const otherPaidRows = subscriptions.filter(item => item.projectId !== targetProjectId && item.pay === '已缴款')
  const paymentDemoRows = subscriptions.filter(item => /^SUB-MOCK-WJK-\d{3}$/.test(item.id))
  const untouchedUnpaidDemoRows = paymentDemoRows.filter(item => item.pay === '未缴款')

  assert.equal(targetPayments.length, 3)
  assert.equal(otherPaidRows.length, 0)
  assert.equal(paymentDemoRows.length, 10)
  assert.ok(untouchedUnpaidDemoRows.every(item => !item.paymentUploadedAt && (item.paymentImages?.length ?? 0) === 0))
})
