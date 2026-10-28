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

test('review project selection replaces a stale draft with a project having pending records', async () => {
  const { selectPaymentReviewProject } = await import('../src/payment-review.ts')
  const projects = [{ id: 'old', title: '旧采购单' }, { id: 'done', title: '已审核项目' }, { id: 'current', title: '当前项目' }]
  const rows = [{ projectId: 'done', project: '已审核项目', pay: '已收款' }, { projectId: 'current', project: '当前项目', pay: '待复核' }]
  assert.equal(selectPaymentReviewProject(projects, rows, 'old'), 'current')
  assert.equal(selectPaymentReviewProject(projects, rows, 'done'), 'done')
  assert.equal(selectPaymentReviewProject(projects, [], 'old'), '')
})
