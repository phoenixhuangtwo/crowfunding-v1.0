export type IamTokenPair = Readonly<{
  accessToken: string
  refreshToken: string
  tokenType: 'Bearer'
  expiresIn: number
  clientId: 'crowdfunding'
  scopes: readonly string[]
  tenantId: string
}>

export type IamTokenClaims = Readonly<{
  active: boolean
  userId: string
  tenantId: string
  clientId: 'crowdfunding'
  scopes: readonly string[]
}>

export type IamUser = Readonly<{
  id: string
  username: string
  nickname: string
  avatar?: string
  deptId?: string
}>

export type IamMenu = Readonly<{
  id: string
  parentId?: string
  name: string
  icon?: string
  path?: string
  component?: string
  componentName?: string
  type?: number
  sort?: number
  visible?: number
  keepAlive?: boolean
  alwaysShow?: boolean
  permission?: string
  children: readonly IamMenu[]
}>

export type IamPermissionInfo = Readonly<{
  user: IamUser
  roleCodes: readonly string[]
  permissions: readonly string[]
  apiPermissions: readonly string[]
  uiPermissions: readonly string[]
  clientId: 'crowdfunding'
  dataScope: IamDataScope
  menus: readonly IamMenu[]
}>

export type IamDataScope = Readonly<{
  all: boolean
  self: boolean
  deptIds: readonly string[]
}>

export type IamRequestContext = Readonly<{
  accessToken: string
  tenantId: string
  userId: string
  clientId: 'crowdfunding'
  scopes: readonly string[]
  user?: IamUser
  roleCodes?: readonly string[]
  permissions?: readonly string[]
  apiPermissions?: readonly string[]
  uiPermissions?: readonly string[]
  menus?: readonly IamMenu[]
  dataScope?: IamDataScope
}>
