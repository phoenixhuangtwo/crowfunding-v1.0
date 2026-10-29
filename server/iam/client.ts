import JSONBig from 'json-bigint'
import type { IamConfig } from './config.ts'
import {
  IamDeniedError,
  IamProtocolError,
  IamUnauthorizedError,
  IamUnavailableError
} from './errors.ts'
import { normalizeIamId, parseIamJson } from './json.ts'
import type {
  IamDataScope,
  IamMenu,
  IamPermissionInfo,
  IamTokenClaims,
  IamTokenPair,
  IamUser
} from './types.ts'

export type IamFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export type IamClientDependencies = {
  fetch?: IamFetch
}

type RequestFailure = 'protocol' | 'token'

const iamJson = JSONBig({ strict: true, useNativeBigInt: true })

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function own(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function protocol(): never {
  throw new IamProtocolError()
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return protocol()
  return value
}

function exactString(value: unknown, expected: string): void {
  if (value !== expected) protocol()
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) return protocol()
  return [...value]
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return protocol()
  return value
}

function optionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'string') return protocol()
  return value
}

function optionalInteger(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined
  return integer(value)
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'boolean') return protocol()
  return value
}

function normalizedId(value: unknown, allowZero = false): string {
  try {
    return normalizeIamId(value, { allowZero })
  } catch {
    return protocol()
  }
}

function aliased(data: Record<string, unknown>, snake: string, camel: string): unknown {
  const hasSnake = own(data, snake)
  const hasCamel = own(data, camel)
  if (!hasSnake && !hasCamel) return protocol()
  if (hasSnake && hasCamel && data[snake] !== data[camel]) return protocol()
  return hasSnake ? data[snake] : data[camel]
}

function parseMenu(value: unknown): IamMenu {
  if (!record(value) || !Array.isArray(value.children)) return protocol()
  const menu: {
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
  } = {
    id: normalizedId(value.id),
    name: nonEmptyString(value.name),
    children: value.children.map(parseMenu)
  }
  if (value.parentId !== null && value.parentId !== undefined) {
    menu.parentId = normalizedId(value.parentId, true)
  }
  for (const key of ['icon', 'path', 'component', 'componentName', 'permission'] as const) {
    const parsed = optionalString(value[key])
    if (parsed !== undefined) menu[key] = parsed
  }
  for (const key of ['type', 'sort', 'visible'] as const) {
    const parsed = optionalInteger(value[key])
    if (parsed !== undefined) menu[key] = parsed
  }
  for (const key of ['keepAlive', 'alwaysShow'] as const) {
    const parsed = optionalBoolean(value[key])
    if (parsed !== undefined) menu[key] = parsed
  }
  return menu
}

function parseDataScope(value: unknown): IamDataScope {
  if (!record(value) || typeof value.all !== 'boolean' || typeof value.self !== 'boolean') return protocol()
  if (!Array.isArray(value.deptIds)) return protocol()
  return {
    all: value.all,
    self: value.self,
    deptIds: value.deptIds.map(id => normalizedId(id))
  }
}

function parseUser(value: unknown): IamUser {
  if (!record(value)) return protocol()
  const user: { id: string; username: string; nickname: string; avatar?: string; deptId?: string } = {
    id: normalizedId(value.id),
    username: nonEmptyString(value.username),
    nickname: nonEmptyString(value.nickname)
  }
  const avatar = optionalString(value.avatar)
  if (avatar !== undefined) user.avatar = avatar
  if (value.deptId !== null && value.deptId !== undefined) user.deptId = normalizedId(value.deptId)
  return user
}

export class IamClient {
  readonly #fetch: IamFetch

  constructor(readonly config: IamConfig, dependencies: IamClientDependencies = {}) {
    this.#fetch = dependencies.fetch ?? globalThis.fetch.bind(globalThis)
  }

  async exchangeCode(input: { code: string; state: string; verifier: string }): Promise<IamTokenPair> {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: nonEmptyString(input.code),
      redirect_uri: this.config.redirectUri.href,
      state: nonEmptyString(input.state),
      code_verifier: nonEmptyString(input.verifier)
    })
    return this.tokenPair(await this.form('/api/oauth2/token', form, undefined, 'token'))
  }

  async refresh(refreshToken: string): Promise<IamTokenPair> {
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: nonEmptyString(refreshToken)
    })
    return this.tokenPair(await this.form('/api/oauth2/token', form, undefined, 'token'))
  }

  async revoke(accessToken: string): Promise<boolean> {
    const data = await this.form('/api/oauth2/revoke', new URLSearchParams({
      token: nonEmptyString(accessToken)
    }))
    if (typeof data !== 'boolean') return protocol()
    return data
  }

  async checkToken(accessToken: string): Promise<IamTokenClaims> {
    const data = await this.form('/api/oauth2/check-token', new URLSearchParams({
      token: nonEmptyString(accessToken)
    }), undefined, 'token')
    if (!record(data) || typeof data.active !== 'boolean') return protocol()
    if (!data.active) throw new IamUnauthorizedError()

    const clientId = aliased(data, 'client_id', 'clientId')
    if (clientId !== this.config.clientId) throw new IamUnauthorizedError()
    const tenantId = normalizedId(aliased(data, 'tenant_id', 'tenantId'), true)
    if (!this.config.multiTenantEnabled && tenantId !== this.config.defaultTenantId) {
      throw new IamUnauthorizedError()
    }

    return {
      active: true,
      userId: normalizedId(aliased(data, 'user_id', 'userId')),
      tenantId,
      clientId: 'crowdfunding',
      scopes: stringList(data.scopes)
    }
  }

  async decideApi(accessToken: string, apiCode: string, tenantId: string): Promise<boolean> {
    const data = await this.form('/api/oauth2/permission/decision', new URLSearchParams({
      access_token: nonEmptyString(accessToken),
      api_code: nonEmptyString(apiCode)
    }), tenantId)
    if (!record(data) || typeof data.subjectValid !== 'boolean' || typeof data.allowed !== 'boolean') {
      return protocol()
    }
    if (!data.subjectValid && data.allowed) return protocol()
    if (!data.subjectValid || !data.allowed) throw new IamDeniedError()
    return true
  }

  async permissionInfo(accessToken: string): Promise<IamPermissionInfo> {
    const data = await this.execute('/api/auth/permission-info', {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${nonEmptyString(accessToken)}`
      }
    }, 'token')
    if (!record(data) || !Array.isArray(data.menus)) return protocol()
    exactString(data.clientId, this.config.clientId)
    const dataScope = parseDataScope(data.dataScope)
    return {
      user: parseUser(data.user),
      roleCodes: stringList(data.roles),
      permissions: stringList(data.permissions),
      apiPermissions: stringList(data.apiPermissions),
      uiPermissions: stringList(data.uiPermissions),
      clientId: 'crowdfunding',
      dataScope,
      menus: data.menus.map(parseMenu)
    }
  }

  async dataScope(userId: string, tenantId: string): Promise<IamDataScope> {
    const normalizedUserId = normalizedId(userId)
    const body = iamJson.stringify({
      userId: BigInt(normalizedUserId),
      clientId: this.config.clientId
    })
    if (typeof body !== 'string') return protocol()
    const data = await this.execute('/rpc-api/system/permission/data-scope', {
      method: 'POST',
      headers: this.basicHeaders('application/json', tenantId),
      body
    })
    return parseDataScope(data)
  }

  private tokenPair(value: unknown): IamTokenPair {
    if (!record(value)) return protocol()
    const clientId = aliased(value, 'client_id', 'clientId')
    exactString(clientId, this.config.clientId)
    const tokenType = nonEmptyString(value.token_type)
    exactString(tokenType, 'Bearer')
    const expiresIn = integer(value.expires_in)
    if (expiresIn < 0) return protocol()
    const tenantId = normalizedId(aliased(value, 'tenant_id', 'tenantId'), true)
    if (!this.config.multiTenantEnabled && tenantId !== this.config.defaultTenantId) return protocol()
    return {
      accessToken: nonEmptyString(aliased(value, 'access_token', 'accessToken')),
      refreshToken: nonEmptyString(aliased(value, 'refresh_token', 'refreshToken')),
      tokenType: 'Bearer',
      expiresIn,
      clientId: 'crowdfunding',
      scopes: stringList(value.scopes),
      tenantId
    }
  }

  private form(
    path: string,
    form: URLSearchParams,
    tenantId?: string,
    failure: RequestFailure = 'protocol'
  ): Promise<unknown> {
    return this.execute(path, {
      method: 'POST',
      headers: this.basicHeaders('application/x-www-form-urlencoded', tenantId),
      body: form.toString()
    }, failure)
  }

  private basicHeaders(contentType: string, tenantId?: string): Record<string, string> {
    const credential = `${this.config.clientId}:${this.config.clientSecret}`
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': contentType,
      Authorization: `Basic ${Buffer.from(credential, 'utf8').toString('base64')}`
    }
    const normalizedTenantId = this.tenantHeader(tenantId)
    if (normalizedTenantId !== undefined) headers['tenant-id'] = normalizedTenantId
    return headers
  }

  private tenantHeader(tenantId?: string): string | undefined {
    if (tenantId === undefined) return undefined
    const normalized = normalizedId(tenantId, true)
    if (!this.config.multiTenantEnabled) {
      if (normalized !== this.config.defaultTenantId) protocol()
      return undefined
    }
    return normalized
  }

  private async execute(path: string, init: RequestInit, failure: RequestFailure = 'protocol'): Promise<unknown> {
    const controller = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    const clear = () => {
      if (timeout !== undefined) clearTimeout(timeout)
      timeout = undefined
    }
    const arm = (milliseconds: number) => {
      clear()
      timeout = setTimeout(() => controller.abort(), milliseconds)
    }

    try {
      let response: Response
      arm(this.config.connectTimeoutMs)
      try {
        response = await this.#fetch(new URL(path, this.config.baseUrl), {
          ...init,
          signal: controller.signal
        })
      } catch {
        throw new IamUnavailableError()
      } finally {
        clear()
      }

      let text: string
      arm(this.config.readTimeoutMs)
      try {
        text = await response.text()
      } catch {
        throw new IamUnavailableError()
      } finally {
        clear()
      }

      if (response.status >= 500) throw new IamUnavailableError()
      if (response.status < 200 || response.status >= 300) {
        if (failure === 'token' && [400, 401, 403].includes(response.status)) {
          throw new IamUnauthorizedError()
        }
        throw new IamProtocolError()
      }

      let envelope: unknown
      try {
        envelope = parseIamJson(text)
      } catch {
        throw new IamProtocolError()
      }
      if (!record(envelope) || envelope.code !== 0 || !own(envelope, 'data')) return protocol()
      return envelope.data
    } finally {
      clear()
    }
  }
}
