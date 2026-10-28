import { isAdminProjectCostVisible } from '../src/admin-project-actions.ts'
import assert from 'node:assert/strict'
import test from 'node:test'

test('admin project actions keep at most three primary buttons and move risky actions into more', async () => {
  let getAdminProjectActionLayout: undefined | ((project: { status: string; remain: number }) => {
    showPayReview: boolean
    showSettlement: boolean
    showOpen: boolean
    showTerminate: boolean
    showTakeover: boolean
    showMore: boolean
  })

  try {
    ;({ getAdminProjectActionLayout } = await import('../src/admin-project-actions.ts'))
  } catch {
    // The assertion below records the missing production behavior as a normal test failure.
  }

  assert.equal(typeof getAdminProjectActionLayout, 'function')
  assert.deepEqual(getAdminProjectActionLayout!({ status: '未开放', remain: 100 }), {
    showPayReview: false,
    showSettlement: false,
    showOpen: true,
    showTerminate: true,
    showTakeover: false,
    showMore: true
  })
  assert.deepEqual(getAdminProjectActionLayout!({ status: '未满额', remain: 100 }), {
    showPayReview: true,
    showSettlement: false,
    showOpen: false,
    showTerminate: true,
    showTakeover: true,
    showMore: true
  })
  assert.deepEqual(getAdminProjectActionLayout!({ status: '未满额', remain: 0 }), {
    showPayReview: true,
    showSettlement: false,
    showOpen: false,
    showTerminate: true,
    showTakeover: false,
    showMore: true
  })
  assert.deepEqual(getAdminProjectActionLayout!({ status: '已满额', remain: 0 }), {
    showPayReview: true,
    showSettlement: true,
    showOpen: false,
    showTerminate: false,
    showTakeover: false,
    showMore: false
  })
  assert.equal(getAdminProjectActionLayout!({ status: '已中断', remain: 100 }).showSettlement, false)
  assert.equal(getAdminProjectActionLayout!({ status: '部分已结算', remain: 0 }).showSettlement, true)
})

test('admin list hides historical procurement projects below the displayed 500 yuan cost', async () => {
  const module = await import('../src/admin-project-actions.ts')
  const visible = (module as Record<string, unknown>).isAdminProjectCostVisible as (id: string, cost: number) => boolean
  assert.equal(typeof visible, 'function')
  assert.equal(visible('PRJ-FSY-OFFLINE-1', 499.99), false)
  assert.equal(visible('PRJ-FSY-OFFLINE-2', 1), false)
  assert.equal(visible('PRJ-FSY-OFFLINE-3', 500), true)
  assert.equal(visible('PRJ-FSY-OFFLINE-4', 500.01), true)
  assert.equal(visible('LOCAL-1', 1), true)
})

test('admin procurement options exclude sales below cost and retain equal amounts', () => {
  assert.equal(isAdminProjectCostVisible('PRJ-FSY-OFFLINE-1', 600, 599.99), false)
  assert.equal(isAdminProjectCostVisible('PRJ-FSY-OFFLINE-1', 600, 600), true)
  assert.equal(isAdminProjectCostVisible('PRJ-FSY-OFFLINE-1', 600, 601), true)
})
