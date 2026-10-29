import assert from 'node:assert/strict'
import test from 'node:test'

test('subscription rule keyword filters by rule name, project name, or rule code', async () => {
  let filterSubscriptionRules: undefined | ((rows: Array<Record<string, string>>, filters: Record<string, string>) => Array<Record<string, string>>)

  try {
    ;({ filterSubscriptionRules } = await import('../src/subscription-rule-filter.ts'))
  } catch {
    // The assertion below records the missing production behavior as a normal test failure.
  }

  assert.equal(typeof filterSubscriptionRules, 'function', 'rule list needs a reusable client-side filter')

  const rules = [
    { id: 'RULE-CN-001', ruleName: '中国家庭医生', projectId: 'PROJECT-A', projectName: '7月品牌提示物', status: '已启用' },
    { id: 'RULE-OFFICE-002', ruleName: '办公设备规则', projectId: 'PROJECT-B', projectName: '2026-Q3 办公设备集采认购', status: '已停用' }
  ]

  assert.deepEqual(filterSubscriptionRules!(rules, { keyword: ' 中国 ', projectId: '全部', status: '全部' }), [rules[0]])
  assert.deepEqual(filterSubscriptionRules!(rules, { keyword: '办公设备集采', projectId: '全部', status: '全部' }), [rules[1]])
  assert.deepEqual(filterSubscriptionRules!(rules, { keyword: 'rule-cn-001', projectId: '全部', status: '全部' }), [rules[0]])
  assert.deepEqual(filterSubscriptionRules!(rules, { keyword: '', projectId: 'PROJECT-B', status: '已停用' }), [rules[1]])
})
