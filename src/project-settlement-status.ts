export type ProjectLifecycleStatus = '未开放' | '未满额' | '已满额' | '已截止' | '待回款' | '回款中' | '待分配' | '分配中' | '已冻结' | '已中断' | '关闭中' | '已关闭' | '采购失败终止中' | '已终止' | '部分已结算' | '已完结'

export type ProjectSettlementStatus = '未开放' | '未满额' | '待结算' | '待回款' | '回款中' | '待分配' | '分配中' | '已冻结' | '已中断' | '关闭中' | '已关闭' | '采购失败终止中' | '已终止' | '历史待核实'

export function projectSettlementStatus(status: ProjectLifecycleStatus): ProjectSettlementStatus {
  if (status === '已完结' || status === '部分已结算') return '历史待核实'
  if (status === '已满额' || status === '已截止') return '待结算'
  if (status === '已中断') return '已中断'
  return status
}
