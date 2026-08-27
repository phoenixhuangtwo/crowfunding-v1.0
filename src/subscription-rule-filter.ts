export type SubscriptionRuleFilter = {
  keyword: string
  projectId: string
  status: string
}

export type SubscriptionRuleFilterRow = {
  id: string
  ruleName: string
  projectId: string
  projectName: string
  status: string
}

export function filterSubscriptionRules<T extends SubscriptionRuleFilterRow>(rows: T[], filters: SubscriptionRuleFilter): T[] {
  const keyword = filters.keyword.trim().toLocaleLowerCase('zh-CN')

  return rows.filter(rule => {
    const keywordMatched = !keyword || [rule.ruleName, rule.projectName, rule.id]
      .some(value => value.toLocaleLowerCase('zh-CN').includes(keyword))
    const projectMatched = filters.projectId === '全部' || rule.projectId === filters.projectId
    const statusMatched = filters.status === '全部' || rule.status === filters.status
    return keywordMatched && projectMatched && statusMatched
  })
}
