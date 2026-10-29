import assert from 'node:assert/strict'
import test from 'node:test'
import { isCrowdfundingListProject } from '../src/project-list-visibility.ts'

test('crowdfunding list excludes imported drafts and retains opened crowdfunding lifecycle records', () => {
  assert.equal(isCrowdfundingListProject({ status: '未开放' }), false)
  assert.equal(isCrowdfundingListProject({ status: '未开放', ruleId: 'RULE-1' }), false)
  assert.equal(isCrowdfundingListProject({ status: '未满额' }), false)
  for (const status of ['未满额', '已满额', '已冻结', '已完结']) {
    assert.equal(isCrowdfundingListProject({ status, ruleId: 'RULE-1' }), true)
  }
})
