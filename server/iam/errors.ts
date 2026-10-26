export class IamUnauthorizedError extends Error {
  constructor() {
    super('IAM token 无效')
    this.name = 'IamUnauthorizedError'
  }
}

export class IamDeniedError extends Error {
  constructor() {
    super('IAM 权限拒绝')
    this.name = 'IamDeniedError'
  }
}

export class IamUnavailableError extends Error {
  constructor() {
    super('IAM 服务不可用')
    this.name = 'IamUnavailableError'
  }
}

export class IamProtocolError extends Error {
  constructor() {
    super('IAM 响应协议无效')
    this.name = 'IamProtocolError'
  }
}
