import assert from 'node:assert/strict'
import test from 'node:test'
import { reconcileProcurementFunding, validateProcurementPayment, type ProcurementPaymentInput } from '../server/finance/procurement-payment.ts'

const now = new Date('2026-10-26T04:00:00.000Z')
const base: ProcurementPaymentInput = {
  projectId: 'PRJ-1', purchaseCents: 30000, approvedEmployeeCents: 20000,
  companyFrontCents: 5000, companyBackstopCents: 5000, pendingReviewCount: 0,
  amountCents: 30000, transactionNo: 'BANK-PAY-001', paidAt: '2026-10-26T03:00:00.000Z',
  proofAssetIds: ['ASSET-1'], recognizedCents: 30000, recognizedTransactionNo: 'BANK-PAY-001',
  recognizedPaidAt: '2026-10-26T03:00:00.000Z',
  recognitionFailed: false, companyFundsConfirmed: true, operatorId: 'finance-1', alreadyRegistered: false
}

test('purchase funding reconciliation returns exact cents and pending count', () => {
  assert.deepEqual(reconcileProcurementFunding(base), {
    purchaseCents: 30000, employeeCents: 20000, companyCents: 10000,
    pendingReviewCount: 0, differenceCents: 0, balanced: true
  })
  assert.deepEqual(reconcileProcurementFunding({ ...base, approvedEmployeeCents: 19999 }).differenceCents, -1)
  assert.equal(reconcileProcurementFunding({ ...base, pendingReviewCount: 1 }).balanced, false)
})

test('registration requires closed funding, no pending review and one exact payment', () => {
  const result = validateProcurementPayment(base, [], now)
  assert.equal(result.amountCents, 30000)
  assert.equal(result.recognitionStatus, '凭证已核对')
  assert.throws(() => validateProcurementPayment({ ...base, pendingReviewCount: 1 }, [], now), /1 笔未复核/)
  assert.throws(() => validateProcurementPayment({ ...base, approvedEmployeeCents: 19999 }, [], now), /低于采购金额 0.01 元/)
  assert.throws(() => validateProcurementPayment({ ...base, approvedEmployeeCents: 20001 }, [], now), /高于采购金额 0.01 元/)
  assert.throws(() => validateProcurementPayment({ ...base, amountCents: 29999 }, [], now), /付款金额须等于/)
  assert.throws(() => validateProcurementPayment({ ...base, alreadyRegistered: true }, [], now), /已登记付款/)
})

test('registration checks company funds even when its contribution is zero', () => {
  assert.throws(() => validateProcurementPayment({ ...base, companyFundsConfirmed: false }, [], now), /公司出资已到位/)
  const noCompany = { ...base, approvedEmployeeCents: 30000, companyFrontCents: 0, companyBackstopCents: 0 }
  assert.throws(() => validateProcurementPayment(noCompany, [], now), /出资为零/)
  assert.equal(validateProcurementPayment({ ...noCompany, note: '本单公司出资为零' }, [], now).companyFundsConfirmed, true)
})

test('bank record and proof must agree; recognition failure requires an explanation', () => {
  assert.throws(() => validateProcurementPayment(base, ['BANK-PAY-001'], now), /已被使用/)
  assert.throws(() => validateProcurementPayment({ ...base, paidAt: '2026-10-26T05:00:00.000Z' }, [], now), /付款时间/)
  assert.throws(() => validateProcurementPayment({ ...base, proofAssetIds: [] }, [], now), /付款凭证/)
  assert.throws(() => validateProcurementPayment({ ...base, recognizedCents: 29999 }, [], now), /凭证识别结果/)
  assert.throws(() => validateProcurementPayment({ ...base, recognizedPaidAt: '2026-10-26T02:59:00.000Z' }, [], now), /凭证识别结果/)
  assert.throws(() => validateProcurementPayment({ ...base, recognitionFailed: true }, [], now), /情况说明/)
  assert.equal(validateProcurementPayment({ ...base, recognitionFailed: true, note: '凭证图片模糊，财务已线下核对银行流水' }, [], now).recognitionStatus, '凭证识别未通过')
})
