import assert from 'node:assert/strict'
import test from 'node:test'
import { confirmProjectSettlement } from '../server/project-settlement.ts'

function projectFixture() {
  return {
    id: 'PRJ-FSY-OFFLINE-368',
    status: '已满额' as const,
    statusType: 'success' as const,
    salesAmount: 24530.18,
    settledAmount: 0,
    settlementInvoices: []
  }
}

test('confirming less than project sales income marks the project partially settled and keeps upload open', () => {
  const project = projectFixture()
  const result = confirmProjectSettlement(project, {
    idempotencyKey: 'SETTLEMENT-INVOICE-001',
    amount: 10000,
    fileName: '第一次回单.png',
    imageUrl: 'data:image/png;base64,FIRST',
    transactionDate: '2026年08月21日',
    payer: '广州福尚云科技研发有限公司',
    payee: '文鱼科技(上海)有限公司',
    operator: 'finance01 · 财务'
  }, '2026-08-26 18:00:00')

  assert.equal(project.status, '部分已结算')
  assert.equal(project.statusType, 'warning')
  assert.equal(project.settledAmount, 10000)
  assert.equal(result.remainingAmount, 14530.18)
  assert.equal(result.canUploadMore, true)
  assert.equal(project.settlementInvoices.length, 1)
  assert.equal(project.settlementInvoices[0].imageUrl, 'data:image/png;base64,FIRST')
  assert.equal(project.settlementInvoices[0].resultStatus, '部分已结算')
  assert.equal(project.settlementInvoices[0].settledAmountAfter, 10000)
  assert.equal(project.settlementInvoices[0].remainingAmountAfter, 14530.18)
})

test('multiple confirmed invoices that reach project sales income complete the project and close upload', () => {
  const project = projectFixture()
  confirmProjectSettlement(project, {
    idempotencyKey: 'SETTLEMENT-INVOICE-001',
    amount: 10000,
    fileName: '第一次回单.png',
    imageUrl: 'data:image/png;base64,FIRST',
    transactionDate: '2026年08月21日',
    payer: '广州福尚云科技研发有限公司',
    payee: '文鱼科技(上海)有限公司',
    operator: 'finance01 · 财务'
  }, '2026-08-26 18:00:00')

  const result = confirmProjectSettlement(project, {
    idempotencyKey: 'SETTLEMENT-INVOICE-002',
    amount: 14530.18,
    fileName: '第二次回单.png',
    imageUrl: 'data:image/png;base64,SECOND',
    transactionDate: '2026年08月22日',
    payer: '广州福尚云科技研发有限公司',
    payee: '文鱼科技(上海)有限公司',
    operator: 'finance01 · 财务'
  }, '2026-08-26 18:05:00')

  assert.equal(project.status, '已完结')
  assert.equal(project.statusType, 'info')
  assert.equal(project.settledAmount, 24530.18)
  assert.equal(result.remainingAmount, 0)
  assert.equal(result.canUploadMore, false)
  assert.equal(project.settlementInvoices.length, 2)
  assert.equal(project.settlementInvoices[1].imageUrl, 'data:image/png;base64,SECOND')
  assert.equal(project.settlementInvoices[1].resultStatus, '已完结')
  assert.equal(project.settlementInvoices[1].settledAmountAfter, 24530.18)
  assert.equal(project.settlementInvoices[1].remainingAmountAfter, 0)
})

test('settlement confirmation rejects an amount above the remaining sales income without mutation', () => {
  const project = projectFixture()
  assert.throws(() => confirmProjectSettlement(project, {
    idempotencyKey: 'SETTLEMENT-INVOICE-OVER',
    amount: 24530.19,
    fileName: '超额回单.png',
    imageUrl: 'data:image/png;base64,OVER',
    transactionDate: '2026年08月21日',
    payer: '付款方',
    payee: '收款方',
    operator: 'finance01 · 财务'
  }, '2026-08-26 18:00:00'), /交易金额超过项目剩余待结算金额/)

  assert.equal(project.status, '已满额')
  assert.equal(project.settledAmount, 0)
  assert.equal(project.settlementInvoices.length, 0)
})

test('repeating the same settlement idempotency key does not add the amount twice', () => {
  const project = projectFixture()
  const input = {
    idempotencyKey: 'SETTLEMENT-INVOICE-001',
    amount: 10000,
    fileName: '第一次回单.png',
    imageUrl: 'data:image/png;base64,FIRST',
    transactionDate: '2026年08月21日',
    payer: '付款方',
    payee: '收款方',
    operator: 'finance01 · 财务'
  }
  confirmProjectSettlement(project, input, '2026-08-26 18:00:00')
  const repeated = confirmProjectSettlement(project, input, '2026-08-26 18:01:00')

  assert.equal(repeated.duplicate, true)
  assert.equal(project.settledAmount, 10000)
  assert.equal(project.settlementInvoices.length, 1)
})

test('settlement confirmation rejects projects outside the settlement lifecycle without mutation', () => {
  for (const status of ['未开放', '未满额', '已中断']) {
    const project = { ...projectFixture(), status, settlementInvoices: [] }
    assert.throws(() => confirmProjectSettlement(project, {
      idempotencyKey: `SETTLEMENT-${status}`,
      amount: 100,
      fileName: '非法状态回单.png',
      imageUrl: 'data:image/png;base64,INVALID',
      transactionDate: '2026年08月21日',
      payer: '付款方',
      payee: '收款方',
      operator: 'finance01 · 财务'
    }, '2026-08-26 18:00:00'), /当前状态不允许确认结算/)

    assert.equal(project.status, status)
    assert.equal(project.settledAmount, 0)
    assert.equal(project.settlementInvoices.length, 0)
  }
})

test('settlement confirmation rejects amounts below the smallest currency unit', () => {
  const project = projectFixture()
  assert.throws(() => confirmProjectSettlement(project, {
    idempotencyKey: 'SETTLEMENT-SUB-CENT',
    amount: 0.001,
    fileName: '小数金额回单.png',
    imageUrl: 'data:image/png;base64,SUBCENT',
    transactionDate: '2026年08月21日',
    payer: '付款方',
    payee: '收款方',
    operator: 'finance01 · 财务'
  }, '2026-08-26 18:00:00'), /交易金额不能低于 0.01 元/)

  assert.equal(project.status, '已满额')
  assert.equal(project.settledAmount, 0)
  assert.equal(project.settlementInvoices.length, 0)
})
