type PaymentReviewRow = {
  projectId?: string
  project: string
  pay: string
}

type PaymentReviewProject = {
  id: string
  title: string
}

export function filterTargetProjectPaymentReviews<T extends PaymentReviewRow>(rows: T[], project: PaymentReviewProject) {
  const paymentRecordStatuses = new Set(['待复核', '已缴款', '部分缴款', '复核驳回', '待确认收款', '已收款'])
  return rows.filter(row => {
    const belongsToProject = row.projectId ? row.projectId === project.id : row.project === project.title
    return belongsToProject && paymentRecordStatuses.has(row.pay)
  })
}
