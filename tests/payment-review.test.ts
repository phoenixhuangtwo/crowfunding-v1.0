import test from 'node:test'
import assert from 'node:assert/strict'
import { filterTargetProjectPaymentReviews } from '../src/payment-review.ts'

test('payment review queue includes pending and completed payments for the target project and excludes unpaid or other projects', () => {
  const rows = [
    { id: 'A-1', projectId: 'PROJECT-A', project: '目标项目', pay: '待复核' },
    { id: 'A-2', project: '目标项目', pay: '待复核' },
    { id: 'A-PAID', projectId: 'PROJECT-A', project: '目标项目', pay: '已缴款' },
    { id: 'A-UNPAID', projectId: 'PROJECT-A', project: '目标项目', pay: '未缴款' },
    { id: 'B-1', projectId: 'PROJECT-B', project: '其他项目', pay: '待复核' }
  ]

  const result = filterTargetProjectPaymentReviews(rows, { id: 'PROJECT-A', title: '目标项目' })

  assert.deepEqual(result.map(item => item.id), ['A-1', 'A-2', 'A-PAID'])
})

test('payment review queue stays empty instead of falling back to unpaid or another project', () => {
  const rows = [
    { id: 'A-UNPAID', projectId: 'PROJECT-A', project: '目标项目', pay: '未缴款' },
    { id: 'B-1', projectId: 'PROJECT-B', project: '其他项目', pay: '待复核' }
  ]

  const result = filterTargetProjectPaymentReviews(rows, { id: 'PROJECT-A', title: '目标项目' })

  assert.deepEqual(result, [])
})
