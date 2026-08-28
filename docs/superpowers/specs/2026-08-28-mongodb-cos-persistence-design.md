# 众筹平台 MongoDB 与腾讯云 COS 持久化设计

日期：2026-08-28  
状态：已确认，待实施计划  
适用项目：`/Users/phoenix/Documents/众筹v1.0`

## 1. 背景

当前 Node.js API 在启动时从 `data/dev-state.json` 读取全部业务状态，在每次修改后把完整状态写回同一文件。收款码、支付截图和结算凭证等图片以 Base64 Data URL 形式嵌入业务数据。这种方式不适合作为正式持久化方案：单文件写入无法提供可靠的并发控制，图片会显著放大业务文档，应用内存成为事实上的权威数据源，服务重启和多实例部署也缺少明确的一致性边界。

本设计将业务数据切换到公司测试服务器上已存在的 MongoDB 数据库 `crowfunding`，将图片本体保存到已存在的腾讯云 COS 私有存储桶。MongoDB 业务记录只保存内部文件资产 ID，不保存 Base64、COS 对象键、永久 URL 或临时签名 URL。

## 2. 已确认决策

1. MongoDB 使用公司测试服务器上已存在的独立数据库 `crowfunding`，名称严格保留现有拼写。
2. 保留 `crowfunding` 中全部现有内容，不清空集合、不删除数据库、不覆盖现有记录。
3. 舍弃本地 `data/dev-state.json` 中的旧业务数据，不导入 MongoDB，也不迁移其中的历史 Base64 图片。
4. MongoDB 为空时返回真实空结果，不注入 Mock、演示或种子业务数据。
5. 图片本体保存到已有的腾讯云 COS 私有存储桶。
6. 图片由后端接收、校验并上传 COS；前端不获取 COS 长期或临时凭据。
7. 业务记录只保存内部 `assetId`；COS 映射和文件元数据集中保存于 `file_assets`。
8. 不设计定时清理、cron 或后台周期删除任务。失败补偿优先在请求内完成，剩余异常资产只能通过人工对账和显式命令处理。
9. MongoDB 或 COS 出错时必须明确失败，不回退到 JSON，也不伪造成功结果。

## 3. 目标与非目标

### 3.1 目标

- 让 MongoDB 成为业务数据的唯一事实来源。
- 按领域拆分集合，支持原子更新、索引查询和服务重启后的可靠持久化。
- 让 COS 成为图片二进制内容的唯一事实来源。
- 保持 COS 私有访问，所有图片读取都经过后端鉴权。
- 保留当前业务规则、安全限制、OCR 证明绑定和累计结算语义。
- 在不修改现有数据库内容的前提下完成结构预检和缺失索引创建。
- 提供可重复、可审计、默认只读的人工文件对账能力。

### 3.2 非目标

- 不迁移或修复 `data/dev-state.json` 的历史数据。
- 不自动清理 `crowfunding` 中的任何既有记录。
- 不自动清理 COS 对象或异常文件资产。
- 不实现 JSON/MongoDB 双写或长期兼容读取。
- 不把腾讯云凭据、MongoDB URI 或签名 URL保存到代码仓库。
- 不在本轮设计生产环境部署、跨地域容灾或正式生产切换。

## 4. 总体架构

```text
Vue 3 前端
  |  JSON 业务请求 / multipart 图片上传
  v
Node.js TypeScript API
  |-- 领域服务与权限校验
  |-- MongoDB 数据访问层
  |-- 文件资产服务
  |-- 腾讯云 COS 适配器
  v
MongoDB crowfunding                  腾讯云 COS 私有存储桶
  |-- projects                       |-- crowfunding/<purpose>/<assetId>.<ext>
  |-- subscriptions
  |-- subscription_rules
  |-- receiving_codes
  |-- audit_logs
  |-- risk_events
  `-- file_assets
```

后端不再在模块级数组中维护权威业务状态。HTTP 处理器通过领域服务调用集合级仓储；需要同时修改多个 MongoDB 文档的流程使用事务。COS 与 MongoDB 无法共享事务，因此图片流程使用显式资产状态、请求内补偿和人工对账来处理跨系统一致性。

## 5. 组件边界

### 5.1 MongoDB 连接与启动预检

MongoDB 客户端负责：

- 从服务端环境变量读取连接配置。
- 连接并选择数据库 `crowfunding`。
- 验证部署支持会话和事务；不满足时拒绝启动。
- 检查目标集合的关键字段、重复键和索引冲突。
- 仅创建缺失且不会改变现有数据的集合或索引。
- 对重复键、冲突索引或不兼容旧字段输出结构化错误报告，不自动删除或修改记录。

MongoDB 连接失败时 API 不监听业务端口。运行期间 MongoDB 失联时，受影响接口返回 `503`，不会从 JSON 读取备用数据。

### 5.2 业务仓储

每个仓储只负责一个集合的查询和写入，领域规则保留在服务层：

- `ProjectRepository`
- `SubscriptionRepository`
- `SubscriptionRuleRepository`
- `ReceivingCodeRepository`
- `AuditLogRepository`
- `RiskEventRepository`
- `FileAssetRepository`

仓储接口接受可选 MongoDB session，使项目状态、认购、结算、审计日志和文件引用等关联修改可以在同一事务中提交。

### 5.3 COS 适配器

COS 适配器只暴露以下能力：

- 上传受控二进制流。
- 检查指定对象是否存在。
- 生成短期只读签名地址。
- 删除一个明确指定的对象。

业务服务不能直接拼接 COS URL，也不能把 COS 凭据或对象键返回前端。COS 配置缺失时 API 拒绝启动；运行期间 COS 不可用时，图片上传和读取接口返回 `503`，其他仅依赖 MongoDB 的接口可以继续服务，但健康检查显示对象存储降级。

### 5.4 文件资产服务

文件资产服务负责：

- 生成内部资产 ID 和不可预测的 COS 对象键。
- 校验业务用途、权限、扩展名、MIME、文件魔数、文件大小和 SHA-256。
- 协调 `file_assets` 状态、COS 上传和业务记录引用。
- 为有权限的读取请求生成后端稳定地址或短期 COS 重定向。
- 执行请求内补偿，并记录未完成补偿的明确状态。
- 提供默认只读、显式应用的人工对账命令。

## 6. MongoDB 数据模型

现有 TypeScript 业务字段保持原有语义，持久化时以业务 `id` 作为稳定外部标识，MongoDB `_id` 仅作为数据库内部标识。

### 6.1 集合

| 集合 | 用途 | 关键图片引用 |
| --- | --- | --- |
| `projects` | 项目、状态、金额、结算累计和识别记录 | `settlementInvoices[].assetId` |
| `subscriptions` | 员工/公司认购、支付记录和审核状态 | `paymentImages[].assetId` |
| `subscription_rules` | 项目认购规则 | `receivingCodeId` |
| `receiving_codes` | 收款码配置 | `imageAssetId` |
| `audit_logs` | 业务审计日志 | 无 |
| `risk_events` | 风险事件 | 无 |
| `file_assets` | COS 映射、文件元数据和一致性状态 | 自身即文件资产 |

业务集合不保存 Base64 Data URL、COS `objectKey`、COS URL 或签名 URL。API 为兼容前端展示可以在响应时派生 `/api/files/:assetId/content`，但该地址不写入 MongoDB。

### 6.2 `file_assets` 文档

```ts
type FileAsset = {
  id: string
  provider: 'tencent-cos'
  bucket: string
  region: string
  objectKey: string
  originalName: string
  extension: string
  mimeType: string
  sizeBytes: number
  sha256: string
  purpose: 'receiving-code' | 'payment-proof' | 'settlement-invoice'
  ownerType: 'receiving-code' | 'subscription' | 'project'
  ownerId: string
  status: 'pending' | 'ready' | 'failed' | 'pending_delete'
  createdBy: string
  createdAt: string
  updatedAt: string
  lastError?: string
}
```

不跨业务记录按哈希复用图片。相同 SHA-256 只用于完整性校验和同一请求的幂等判断，避免不同业务对象因为共享文件而发生权限或生命周期串联。

### 6.3 索引

索引创建前必须先做只读冲突扫描。发现冲突时停止启动并报告冲突键，禁止以删除、覆盖或静默跳过的方式“修复”。

| 集合 | 索引 |
| --- | --- |
| `projects` | `id` 唯一；按实际查询补充 `status`、`deadline`、`ruleId` 普通索引 |
| `subscriptions` | `id` 唯一；`idempotencyKey` 部分唯一；`projectId + userId`、`status` 普通索引 |
| `subscription_rules` | `id` 唯一；`projectId`、`status` 普通索引 |
| `receiving_codes` | `id` 唯一；`status` 普通索引 |
| `audit_logs` | `id` 唯一；`time`、`target` 普通索引 |
| `risk_events` | `id` 唯一；`projectId + status` 普通索引 |
| `file_assets` | `id` 唯一；`objectKey` 唯一；`ownerType + ownerId`、`status` 普通索引 |

`idempotencyKey` 的部分唯一条件只覆盖非空字符串，避免历史空值之间产生无意义冲突。

## 7. 图片写入与读取流程

### 7.1 上传并绑定

1. 前端以 `multipart/form-data` 把图片和必要业务参数发送给后端。
2. 后端先完成身份、角色、业务状态和资源配额校验。
3. 后端流式计算 SHA-256，并校验声明 MIME、真实文件魔数、扩展名和大小。
4. MongoDB 新建状态为 `pending` 的 `file_assets` 文档。
5. 后端把对象上传到私有 COS。
6. COS 成功后将资产改为 `ready`。
7. 在 MongoDB 事务中把 `assetId` 绑定到业务文档，并写入审计日志。
8. API 返回业务数据以及派生的后端文件读取地址。

只有 `ready` 状态资产可以绑定或读取。业务文档必须校验资产的 `purpose`、`ownerType` 和 `ownerId`，防止把其他项目或其他用户的图片 ID 绑定过来。

### 7.2 读取

`GET /api/files/:assetId/content` 执行：

1. 查询 `file_assets`，要求状态为 `ready`。
2. 根据用途和业务归属执行身份、角色和项目级权限校验。
3. 生成仅供服务端读取使用的短期 COS 签名请求。
4. 由后端代理流式输出图片内容，不把签名地址返回浏览器。

签名地址不记录到 MongoDB、日志或审计详情。响应禁止公开 bucket、region、objectKey 和任何 COS 凭据。

### 7.3 替换

1. 完整上传并确认新资产为 `ready`。
2. 在 MongoDB 事务中把业务引用切换到新 `assetId`，并将旧资产改为 `pending_delete`。
3. 事务成功后立即尝试删除旧 COS 对象。
4. 删除成功后删除旧资产元数据；删除失败则保留 `pending_delete` 和错误原因，等待人工处理。删除审计由 `audit_logs` 长期保留。

新文件未就绪时绝不移除旧引用，确保替换失败不会丢失当前可用图片。

### 7.4 删除

1. 校验操作者权限和业务状态。
2. 在 MongoDB 事务中解除业务引用、把资产改为 `pending_delete` 并写入审计日志。
3. 事务成功后立即删除明确指定的 COS 对象。
4. COS 删除成功后删除资产元数据；删除审计由 `audit_logs` 长期保留。
5. COS 删除失败时保留 `pending_delete`，接口返回明确的部分失败结果，禁止宣称文件已经彻底删除。

## 8. 跨系统失败与补偿

MongoDB 和 COS 不存在共同事务，采用以下有限状态和请求内补偿：

| 失败点 | 结果与补偿 |
| --- | --- |
| 创建 `pending` 失败 | 不调用 COS，接口失败 |
| COS 上传失败 | 把资产标记为 `failed`；若状态更新也失败，返回组合错误并记录服务端日志 |
| COS 成功但资产改 `ready` 失败 | 请求内立即删除刚上传对象；删除失败则保留可对账的对象键和错误日志 |
| 资产 `ready` 但业务绑定失败 | 请求内把资产改为 `pending_delete` 并立即删除 COS；未完成部分保留人工对账证据 |
| 替换事务失败 | 保留原业务引用；补偿删除新对象 |
| 删除 COS 失败 | 业务引用已解除，资产保留 `pending_delete`，等待人工处理 |

系统不创建任何定时器、cron、TTL 自动删除索引或后台周期清理任务。

### 8.1 人工对账命令

提供独立命令，例如：

```bash
npm run storage:reconcile -- --dry-run
npm run storage:reconcile -- --asset-id <明确资产ID> --apply
```

规则：

- 默认只能 `--dry-run`，列出 `failed`、`pending_delete`、长期 `pending`、缺失 COS 对象和未被业务引用的资产。
- `--apply` 必须同时指定明确资产 ID，不允许全库自动删除。
- 应用前再次验证业务引用和 COS 对象键。
- 每次处理输出操作结果并写入审计日志。
- 对账命令不能扫描或修改 `crowfunding` 之外的数据库和配置前缀之外的 COS 对象。

## 9. API 与前端影响

### 9.1 API

- 所有当前依赖模块级数组的处理器改为异步领域服务调用。
- `/api/health` 返回 MongoDB 提供方、固定数据库名和连接状态，但不返回 URI、用户名或主机密码。
- 健康检查可显示 COS `up/degraded`，但不公开 bucket、region 或对象键。
- 图片上传端点从 JSON Base64 改为 `multipart/form-data`。
- 文件读取统一使用 `/api/files/:assetId/content`。
- 错误码区分 MongoDB 不可用、COS 不可用、文件无效、权限不足、资产状态冲突和部分删除失败。

### 9.2 前端

- 浏览器只上传原始 `File`，不生成用于持久化的 Base64 Data URL。
- 本地预览可以使用短生命周期的 `blob:` URL，但必须及时释放，且不得写入业务请求。
- 前端业务模型使用 `assetId`；展示 URL由 API 响应派生。
- 空集合按真实空态展示，不以本地样例填充。
- COS 或 MongoDB 失败时展示真实错误，不保留看似成功但未持久化的 UI 状态。

## 10. 配置与凭据

服务端环境变量至少包含：

```dotenv
MONGODB_URI=
MONGODB_DB=crowfunding
COS_SECRET_ID=
COS_SECRET_KEY=
COS_BUCKET=
COS_REGION=
COS_OBJECT_PREFIX=crowfunding
COS_SIGNED_URL_TTL_SECONDS=300
```

实际变量名可以在实施计划中按官方 SDK 调整，但必须满足：

- `.env.local` 被 Git 忽略。
- 仓库只提交无秘密的 `.env.example`。
- COS 账号采用最小权限，只允许目标私有存储桶和 `crowfunding/` 前缀所需操作。
- MongoDB 账号只允许 `crowfunding` 所需读写、索引和事务操作。
- 日志、异常、健康检查和测试输出必须脱敏。

## 11. 旧 JSON 与既有 MongoDB 数据策略

### 11.1 本地 JSON

- `data/dev-state.json` 不导入、不读取、不写入。
- 实施和验收期间记录其内容哈希与修改时间，确认测试和运行未改变文件。
- 文件可暂时保留为历史工作区文件，但不是回滚数据源，也不能作为 MongoDB 不可用时的备用数据。
- 后续是否删除该文件属于新的显式破坏性任务，不在本设计范围内。

### 11.2 `crowfunding` 现有内容

- 不删除数据库、集合或文档。
- 不重命名现有集合。
- 不覆盖同 ID 记录。
- 不自动转换遗留 `imageUrl` 或 Base64 字段。
- 如果目标集合存在与新模型不兼容的数据、重复业务 ID、索引冲突或遗留图片字段，预检失败并输出报告，由用户另行决定处理方式。
- 缺失集合和无冲突索引可以非破坏性创建。

## 12. 安全要求

- 图片继续受现有单图大小、总容量、数量、请求体、频率和超时限制保护。
- 文件类型不能只相信扩展名或请求头，必须检查魔数。
- 对象键由系统生成，不能包含用户路径、原始文件名、账号或项目敏感信息。
- OCR 结算继续使用服务端权威、短期且一次性的证明，绑定项目、文件名和图片 SHA-256。
- 文件读取必须重新检查当前业务权限，不能把短期签名 URL 当作永久授权。
- 禁止目录遍历、任意对象键读取、跨项目资产绑定和通过错误消息枚举资产。
- COS SDK、MongoDB 驱动和 multipart 解析器采用受维护的正式依赖，实施时核对官方文档和安全公告。

## 13. 测试设计

### 13.1 单元测试

- 集合名、文档映射和索引定义。
- 业务仓储不读取或写入 JSON。
- MongoDB 为空时返回真实空列表。
- 文件扩展名、MIME、魔数、大小和 SHA-256 校验。
- `pending -> ready -> pending_delete` 状态转换。
- 上传、绑定、替换和删除的请求内补偿。
- 资产用途、所有权和读取权限校验。
- 对账命令默认只读，`--apply` 必须指定资产 ID。
- URI、COS 密钥、签名 URL 和对象键不会泄露到业务响应或日志；文件读取由后端代理输出二进制内容。

### 13.2 MongoDB 集成测试

- 使用运行级唯一临时集合前缀，禁止使用正式集合名。
- 测试创建、查询、更新、事务提交和事务回滚。
- 验证唯一索引、部分唯一索引和冲突预检。
- 在测试结束时只删除本次运行创建的明确临时集合。
- 任何前缀校验失败时拒绝执行清理。
- 不触碰 `crowfunding` 现有业务集合和记录。

### 13.3 COS 集成测试

- 使用配置前缀下的专用 `integration-tests/<runId>/` 对象键。
- 真实上传一个受控小图片，验证存在、受保护读取和 SHA-256，再立即删除同一明确对象。
- 测试结束只删除本次运行创建并记录的对象，不进行目录级批量删除。
- 验证越权 assetId、错误用途、无效类型、超限文件和 COS 故障路径。

### 13.4 E2E 与回归

- 收款码图片上传、预览、替换和删除。
- 支付截图上传、审核预览以及项目级权限。
- 结算凭证上传、OCR 证明、部分结算、累计完成和识别历史。
- API 重启后业务数据仍来自 MongoDB，图片仍从 COS 读取。
- MongoDB/COS 故障显示真实失败，不回退 JSON。
- `data/dev-state.json` 内容哈希和修改时间保持不变。
- 运行全部单元测试、集成测试、冒烟测试、生产构建和安全边界测试。

## 14. 实施与切换顺序

1. 记录当前 Git 状态、JSON 哈希和修改时间。
2. 添加无秘密配置模板、MongoDB/COS 适配器和测试基础设施。
3. 以 TDD 方式实现仓储、领域服务和文件资产服务。
4. 完成所有 API 与前端图片上传协议切换。
5. 对 `crowfunding` 执行只读预检，确认事务支持、数据冲突和索引兼容性。
6. 对 COS 执行专用测试前缀的真实上传、读取和明确对象删除。
7. 停止本地 API，使用新实现重新启动。
8. 非破坏性创建缺失集合和索引。
9. 验证真实空态或数据库现有数据、重启持久化、图片链路和健康检查。
10. 运行完整测试和构建，确认 JSON 未发生变化。

如果任一步失败，则停止切换并修复；不得通过启用 JSON 回退、清空数据库、忽略索引冲突或伪造测试数据绕过失败。

## 15. 验收标准

- API 的所有业务读写以 `crowfunding` 为唯一数据源。
- API 运行期间不调用 `loadState()`、`saveState()`，不读取或写入 `data/dev-state.json`。
- 数据库空时 UI 显示真实空态，不出现 Mock 或种子数据。
- `crowfunding` 原有数据库内容没有被清空、覆盖或批量修改。
- 新增/修改业务数据在 API 重启后仍然存在。
- 图片本体只存在于私有 COS；业务文档只保存 `assetId`。
- 文件读取经过后端权限校验，服务端内部签名请求短期有效、不落库且不返回浏览器。
- 上传、替换、删除和故障补偿行为符合本设计。
- 没有定时器、cron、TTL 自动删除或后台周期清理实现。
- 人工对账命令默认只读，应用模式只能处理明确资产 ID。
- MongoDB/COS 配置和秘密未进入 Git、前端包、响应或日志。
- 单元、MongoDB/COS 集成、E2E、冒烟、安全边界测试和生产构建全部通过。

## 16. 实施前置条件

开始连接真实服务和执行集成测试前，用户需要在本机 `.env.local` 中自行配置 MongoDB 与 COS 参数，不在聊天中发送秘密。实施过程应先验证配置项是否存在和连接是否可用，只报告脱敏后的数据库名、服务状态和测试结果。
