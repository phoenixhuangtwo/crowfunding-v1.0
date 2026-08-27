import assert from 'node:assert/strict'
import test from 'node:test'

test('settlement status keeps unopened, unfilled and interrupted project stages distinct', async () => {
  let projectSettlementStatus: undefined | ((status: string) => string)

  try {
    ;({ projectSettlementStatus } = await import('../src/project-settlement-status.ts'))
  } catch {
    // The assertion below records the missing production behavior as a normal test failure.
  }

  assert.equal(typeof projectSettlementStatus, 'function')
  assert.equal(projectSettlementStatus!('未开放'), '未开放')
  assert.equal(projectSettlementStatus!('未满额'), '未满额')
  assert.equal(projectSettlementStatus!('已满额'), '待结算')
  assert.equal(projectSettlementStatus!('已截止'), '待结算')
  assert.equal(projectSettlementStatus!('部分已结算'), '部分已结算')
  assert.equal(projectSettlementStatus!('已中断'), '已中断')
  assert.equal(projectSettlementStatus!('已完结'), '已结算')
})
