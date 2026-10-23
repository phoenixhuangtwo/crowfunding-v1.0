# API契约

API（Application Programming Interface，应用程序接口）当前由 `server/server.ts` 提供，本文件描述当前本地 MVP 的接口契约。

| Method（请求方法） | Endpoint（接口地址） | 中文说明 | 关联需求 |
|---|---|---|---|
| `GET` | `/api/health` | 健康检查 | REQ-OPS-001 |
| `GET` | `/api/state` | 调试状态读取 | REQ-OPS-001 |
| `GET` | `/api/projects` | 项目列表 | REQ-PRJ-001 |
| `GET` | `/api/rules` | 认购规则列表与筛选 | REQ-RUL-001 |
| `GET` | `/api/receiving-codes` | 收款码列表 | REQ-PAY-001 |
| `GET` | `/api/subscriptions` | 认购列表 | REQ-SUB-001 |
| `GET` | `/api/audit-logs` | 审计日志 | REQ-AUD-001 |
| `GET` | `/api/risk-events` | 风险事件 | REQ-RISK-001 |
| `GET` | `/api/rbac` | 权限矩阵 | REQ-RBAC-001 |
| `POST` | `/api/mcp/sync` | 拉取采购订单，将有效订单幂等映射为未开放项目，返回拉取、新增、更新、跳过与总数 | REQ-SRC-001 |
| `POST` | `/api/subscriptions` | 创建认购 | REQ-SUB-001、REQ-SUB-002 |
| `POST` | `/api/subscriptions/:id/confirm-receipt` | 员工确认收款 | REQ-FIN-001 |
| `POST` | `/api/subscriptions/:id/review` | 财务复核 | REQ-PAY-004 |
| `POST` | `/api/rules` | 创建认购规则 | REQ-RUL-001 |
| `POST` | `/api/rules/:id/update` | 编辑认购规则 | REQ-RUL-001 |
| `POST` | `/api/rules/:id/status` | 启用 / 停用规则 | REQ-RUL-001 |
| `POST` | `/api/rules/:id/delete` | 删除规则 | REQ-RUL-001 |
| `POST` | `/api/receiving-codes` | 创建并持久化收款码 | REQ-PAY-001 |
| `POST` | `/api/receiving-codes/:id/image` | 上传或更换收款码图片；仅限 PNG、JPG/JPEG、WebP 且不超过 5MB | REQ-PAY-001 |
| `POST` | `/api/receiving-codes/:id/disable` | 禁用收款码并记录理由 | REQ-PAY-001 |
| `POST` | `/api/projects/:id/open` | 开放项目 | REQ-PRJ-002 |
| `POST` | `/api/projects/:id/terminate` | 终止项目 | REQ-PRJ-002 |
| `POST` | `/api/projects/:id/interrupt` | 中断项目 | REQ-PRJ-002、REQ-RISK-001 |
| `POST` | `/api/payments/ocr` | 支付 OCR 模拟 | REQ-PAY-002 |
| `POST` | `/api/invoices/ocr` | 服务端代理发票 OCR；请求传入图片 Data URL 和文件名，返回归一化金额、任务号与识别字段 | REQ-SET-001 |
| `POST` | `/api/settlements/calc` | 财务只读利润试算；请求须明确传入四项非负整数分金额，不接受空值或演示默认值 | REQ-SET-001 |
| `POST` | `/api/takeovers/:id/force` | 强制接管 | REQ-CAP-001 |

## 请求示例

### 利润试算

```json
{
  "customerReceiptsCents": 30301,
  "companyTopUpsCents": 600,
  "procurementPaymentsCents": 30000,
  "confirmedCostsCents": 150
}
```

返回 `profitCents: 751` 和 `previewOnly: true`。这只是按输入金额计算，不核验银行流水、不确认回款，也不生成分润或付款记录；调用方须先核实四项金额的来源。

### 创建认购

```json
{
  "projectId": "PRJ-MOCK-WME-002",
  "userId": "employee01",
  "amount": 12000,
  "agreementsConfirmed": true,
  "idempotencyKey": "employee01-PRJ-MOCK-WME-002-20260708"
}
```

### 财务复核

```json
{
  "result": "pass",
  "operator": "finance01 · 财务",
  "remark": "到账金额与凭证一致"
}
```

## 生产化补充

生产环境必须为所有修改类接口补充认证、权限校验、请求签名或 CSRF（Cross-Site Request Forgery，跨站请求伪造）防护、幂等表、错误码规范和审计落库。

采购系统认证信息通过服务端环境变量 `PROCUREMENT_TOKEN` 提供，禁止写入前端代码或构建产物；采购接口地址可通过 `PROCUREMENT_API_URL` 配置。

发票 OCR 认证信息通过服务端环境变量 `INVOICE_OCR_APPCODE` 提供，禁止传入浏览器或前端构建产物；识别服务地址可通过 `INVOICE_OCR_API_URL` 配置，未配置时使用当前供应商 HTTPS 地址。
