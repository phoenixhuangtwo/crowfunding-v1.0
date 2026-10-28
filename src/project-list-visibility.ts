export function isCrowdfundingListProject(project: { status: string; ruleId?: string }): boolean {
  return Boolean(project.ruleId) && project.status !== '未开放'
}
