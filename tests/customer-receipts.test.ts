import assert from 'node:assert/strict'
import test from 'node:test'
import {
  reviewReceiptBatch,
  summarizeProjectReceipts,
  validateReceiptRegistration,
  type ReceiptBatch
} from '../server/finance/customer-receipts.ts'

const now = new Date('2026-10-26T04:00:00.000Z')
const receivables = { 'PRJ-A': 10000, 'PRJ-B': 5000 }

function register(overrides: Record<string, unknown> = {}, existing: ReceiptBatch[] = []) {
  return validateReceiptRegistration({
    id: 'REC-1', kind: '客户回款', transactionNo: 'BANK-001',
    bookedAt: '2026-10-26T03:00:00.000Z', totalCents: 8000,
    lines: [{ projectId: 'PRJ-A', amountCents: 5000 }, { projectId: 'PRJ-B', amountCents: 3000 }],
    proofAssetIds: ['ASSET-1'], recognizedCents: 8000,
    recognizedTransactionNo: 'BANK-001', recognizedAt: '2026-10-26T03:00:00.000Z',
    registeredBy: 'finance-1', ...overrides
  }, existing, receivables, now)
}

function approve(batch: ReceiptBatch, existing: ReceiptBatch[] = []) {
  return reviewReceiptBatch({
    batch, decision: '通过', reviewerId: batch.kind === '客户回款' ? 'finance-1' : 'company-1',
    reviewerRole: batch.kind === '客户回款' ? 'finance' : 'company',
    actualBankCents: batch.totalCents, actualBankTransactionNo: batch.transactionNo,
    now, existing, receivables
  })
}

test('one bank transfer may split across projects only when amounts close exactly', () => {
  const batch = register()
  assert.equal(batch.lines.length, 2)
  assert.equal(batch.totalCents, 8000)
  assert.equal(batch.status, '待复核')
  assert.throws(() => register({ lines: [{ projectId: 'PRJ-A', amountCents: 4999 }, { projectId: 'PRJ-B', amountCents: 3000 }] }), /拆分金额合计/)
  assert.throws(() => register({ lines: [{ projectId: 'PRJ-A', amountCents: 8000.5 }] }), /整数分/)
  assert.throws(() => register({ bookedAt: '2026-10-26T05:00:00.000Z' }), /晚于当前时间/)
})

test('OCR, proof and global bank transaction checks reject mismatches', () => {
  assert.throws(() => register({ recognizedCents: 7999 }), /凭证识别结果/)
  assert.throws(() => register({ recognizedTransactionNo: 'BANK-OTHER' }), /凭证识别结果/)
  assert.throws(() => register({ proofAssetIds: [] }), /回款凭证/)
  assert.throws(() => register({ id: 'REC-2', transactionNo: 'BANK-001' }, [register()]), /已被使用/)
  assert.throws(() => validateReceiptRegistration({
    id: 'REC-3', kind: '客户回款', transactionNo: 'BANK-OTHER',
    bookedAt: '2026-10-26T03:00:00.000Z', totalCents: 100,
    lines: [{ projectId: 'PRJ-A', amountCents: 100 }], proofAssetIds: ['ASSET-2'],
    recognizedCents: 100, recognizedTransactionNo: 'BANK-OTHER', recognizedAt: '2026-10-26T03:00:00.000Z',
    registeredBy: 'finance-1'
  }, [], receivables, now, ['BANK-OTHER']), /已被使用/, '其他资金业务占用的流水号也不可复用')
  const rejected = reviewReceiptBatch({
    batch: register(), decision: '驳回', reviewerId: 'finance-2', reviewerRole: 'finance',
    reason: '凭证与银行流水不符', now, existing: [], receivables
  })
  assert.equal(register({ id: 'REC-2' }, [rejected]).status, '待复核', '驳回后流水号可重新使用')
})

test('company top-up reserves the gap and requires separate company review', () => {
  const topUp = register({
    id: 'TOP-1', kind: '公司补款', transactionNo: 'BANK-TOP-1', totalCents: 4000,
    lines: [{ projectId: 'PRJ-A', amountCents: 4000 }], recognizedCents: 4000,
    recognizedTransactionNo: 'BANK-TOP-1', reason: '客户未支付剩余款项'
  })
  assert.throws(() => register({
    id: 'TOP-2', kind: '公司补款', transactionNo: 'BANK-TOP-2', totalCents: 7000,
    lines: [{ projectId: 'PRJ-A', amountCents: 7000 }], recognizedCents: 7000,
    recognizedTransactionNo: 'BANK-TOP-2', reason: '客户未支付剩余款项'
  }, [topUp]), /补款金额不得超过当前缺口/)
  assert.throws(() => reviewReceiptBatch({
    batch: topUp, decision: '通过', reviewerId: 'finance-1', reviewerRole: 'finance',
    actualBankCents: 4000, actualBankTransactionNo: 'BANK-TOP-1', now, existing: [], receivables
  }), /公司角色复核/)
  assert.equal(approve(topUp).status, '已通过')
})

test('later customer receipts automatically return outstanding top-up per project', () => {
  const topUp = approve(register({
    id: 'TOP-1', kind: '公司补款', transactionNo: 'BANK-TOP-1', totalCents: 4000,
    lines: [{ projectId: 'PRJ-A', amountCents: 4000 }], recognizedCents: 4000,
    recognizedTransactionNo: 'BANK-TOP-1', reason: '客户未支付剩余款项'
  }))
  const customer = approve(register(), [topUp])
  assert.deepEqual(customer.returns, [{ projectId: 'PRJ-A', amountCents: 4000 }])
  assert.deepEqual(summarizeProjectReceipts([topUp, customer], 'PRJ-A', 10000), {
    customerGrossCents: 5000, companyTopUpsCents: 4000, companyReturnsCents: 4000,
    companyBalanceCents: 0, distributableCents: 5000, gapCents: 5000, excessCents: 0
  })
  assert.equal(summarizeProjectReceipts([topUp, customer], 'PRJ-B', 5000).distributableCents, 3000)
  assert.throws(() => reviewReceiptBatch({
    batch: customer, decision: '通过', reviewerId: 'finance-2', reviewerRole: 'finance',
    actualBankCents: customer.totalCents, actualBankTransactionNo: customer.transactionNo,
    now, existing: [topUp], receivables
  }), /已复核/)
})

test('review verifies actual bank amount and rechecks top-up gap', () => {
  const topUp = register({
    id: 'TOP-1', kind: '公司补款', transactionNo: 'BANK-TOP-1', totalCents: 4000,
    lines: [{ projectId: 'PRJ-A', amountCents: 4000 }], recognizedCents: 4000,
    recognizedTransactionNo: 'BANK-TOP-1', reason: '客户未支付剩余款项'
  })
  assert.throws(() => reviewReceiptBatch({
    batch: topUp, decision: '通过', reviewerId: 'company-1', reviewerRole: 'company',
    actualBankCents: 3999, actualBankTransactionNo: 'BANK-TOP-1', now, existing: [], receivables
  }), /金额或流水号不一致/)
  const paid = approve(register({
    id: 'REC-2', totalCents: 9000, lines: [{ projectId: 'PRJ-A', amountCents: 9000 }], recognizedCents: 9000
  }))
  assert.throws(() => approve(topUp, [paid]), /超过当前缺口/)
})
