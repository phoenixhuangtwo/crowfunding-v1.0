export type AdminProjectActionTarget = {
  status: string
  remain: number
}

export type AdminProjectActionLayout = {
  showPayReview: boolean
  showSettlement: boolean
  showOpen: boolean
  showTerminate: boolean
  showTakeover: boolean
  showMore: boolean
}

export function getAdminProjectActionLayout(project: AdminProjectActionTarget): AdminProjectActionLayout {
  const isUnopened = project.status === '未开放'
  const isSettlementEligible = ['已满额', '已截止', '待回款', '部分已结算'].includes(project.status)
  const showTerminate = isUnopened || project.status === '未满额'
  const showTakeover = project.status === '未满额' && project.remain > 0
  return {
    showPayReview: !isUnopened,
    showSettlement: isSettlementEligible,
    showOpen: isUnopened,
    showTerminate,
    showTakeover,
    showMore: showTerminate || showTakeover
  }
}
