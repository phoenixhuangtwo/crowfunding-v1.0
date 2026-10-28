export type IamMenuLike = Readonly<{
  component?: unknown
  componentName?: unknown
  children?: readonly IamMenuLike[]
}>

export type PermissionInfoLike = Readonly<{
  menus?: readonly IamMenuLike[]
  permissions?: readonly unknown[]
  apiPermissions?: readonly unknown[]
  uiPermissions?: readonly unknown[]
  dataScope?: { all?: boolean }
}>

export const AUTHORIZED_PAGE_KEYS = [
  'projects', 'mine', 'myPayouts', 'adminProjects', 'rules', 'receivingCode', 'payReview',
  'settlement', 'procurementPayment', 'customerReceipts', 'distributionOrders', 'exceptionFunds', 'projectRefunds', 'procurementFailure', 'ruleParameters', 'notifications', 'receiptOverdue', 'takeovers', 'audit', 'risk', 'agreements'
] as const

export type AuthorizedPageKey = typeof AUTHORIZED_PAGE_KEYS[number]

function permissionSet(info: PermissionInfoLike | null | undefined, key: 'permissions' | 'apiPermissions' | 'uiPermissions') {
  const values = info?.[key]
  return new Set((Array.isArray(values) ? values : []).filter((value): value is string => typeof value === 'string' && value.length > 0))
}

export function canApi(info: PermissionInfoLike | null | undefined, code: string): boolean {
  if (!code || !info) return false
  return permissionSet(info, 'apiPermissions').has(code)
}

export function canSyncProcurement(role: string, info: PermissionInfoLike | null | undefined): boolean {
  return role === 'admin' && info?.dataScope?.all === true
    && canApi(info, 'crowdfunding:procurement:sync')
}

export function canUi(info: PermissionInfoLike | null | undefined, code: string): boolean {
  if (!code || !info) return false
  return permissionSet(info, 'uiPermissions').has(code)
}

function componentName(menu: IamMenuLike): string | undefined {
  const value = typeof menu.componentName === 'string' ? menu.componentName : menu.component
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function allowedPageKeys(info: PermissionInfoLike | null | undefined): AuthorizedPageKey[] {
  const allowed = new Set<string>(AUTHORIZED_PAGE_KEYS)
  const result: AuthorizedPageKey[] = []
  const visit = (menu: IamMenuLike) => {
    const key = componentName(menu)
    if (key && allowed.has(key) && !result.includes(key as AuthorizedPageKey)) result.push(key as AuthorizedPageKey)
    for (const child of Array.isArray(menu.children) ? menu.children : []) visit(child)
  }
  for (const menu of Array.isArray(info?.menus) ? info.menus : []) visit(menu)
  return result
}
