import assert from 'node:assert/strict'
import test from 'node:test'
import { validateOverdueResolution } from '../server/finance/receipt-overdue.ts'

const at = new Date('2026-10-26T02:00:00.000Z')

test('waiting requires a valid future Shanghai date and a meaningful explanation', () => {
  assert.deepEqual(validateOverdueResolution({ action: '继续等待', note: '已联系客户确认回款计划',
    nextWarningDate: '2026-10-27' }, at), {
    action: '继续等待', note: '已联系客户确认回款计划', nextWarningDate: '2026-10-27'
  })
  for (const date of ['2026-10-26', '2026-02-30', 'bad']) {
    assert.throws(() => validateOverdueResolution({ action: '继续等待',
      note: '已联系客户确认回款计划', nextWarningDate: date }, at))
  }
  assert.throws(() => validateOverdueResolution({ action: '公司补款', note: '短' }, at))
})

test('other actions ignore an irrelevant next warning date', () => {
  assert.deepEqual(validateOverdueResolution({ action: '采购失败终止',
    note: '采购项目已无法继续进行', nextWarningDate: 'invalid' }, at), {
    action: '采购失败终止', note: '采购项目已无法继续进行'
  })
})
