# PRD 基线索引

本目录是 AutoDev（自动开发团队）流程使用的 PRD（Product Requirements Document，产品需求文档）基线。基线描述当前产品 As-Is（现状）行为；`changes/` 目录记录增量 PRD（产品需求变更文档）的评审过程。

## 章节索引

| 编号 | 文件 | 中文说明 | 当前状态 |
|---|---|---|---|
| 01 | [01-内部资金认购平台.md](01-内部资金认购平台.md) | 内部资金认购平台当前产品基线 | active（生效） |

## 变更目录

| 日期 | 文件 | 状态 | 中文说明 |
|---|---|---|---|
| 2026-08-27 | [changes/2026-08-27-settlement-invoice-recognition-history.md](changes/2026-08-27-settlement-invoice-recognition-history.md) | merged（已合入） | 项目结算页底部展示可持久化的发票图片、识别内容与逐笔结算结果 |
| 2026-08-27 | [changes/2026-08-27-settlement-cumulative-confirmation.md](changes/2026-08-27-settlement-cumulative-confirmation.md) | merged（已合入） | 发票金额按项目销售收入累计确认，支持部分结算、补传和足额完结 |
| 2026-08-26 | [changes/2026-08-26-settlement-ocr-fixed-receipt-fields.md](changes/2026-08-26-settlement-ocr-fixed-receipt-fields.md) | merged（已合入） | 结算 OCR 固定展示交易日期、付款人、收款人和交易金额 |
| 2026-08-26 | [changes/2026-08-26-settlement-invoice-advanced-ocr-endpoint.md](changes/2026-08-26-settlement-invoice-advanced-ocr-endpoint.md) | merged（已合入） | 项目结算发票切换阿里云高精版 OCR，并展示识别全文与可提取金额 |
| 2026-08-26 | [changes/2026-08-26-unopened-project-action-visibility.md](changes/2026-08-26-unopened-project-action-visibility.md) | merged（已合入） | 未开放项目隐藏支付复核和去结算，仅保留开放与更多 |
| 2026-08-26 | [changes/2026-08-26-settlement-invoice-real-ocr.md](changes/2026-08-26-settlement-invoice-real-ocr.md) | merged（已合入） | 项目结算发票通过服务端代理调用真实 OCR 并展示识别字段 |
| 2026-08-26 | [changes/2026-08-26-settlement-invoice-upload-compact.md](changes/2026-08-26-settlement-invoice-upload-compact.md) | merged（已合入） | 缩小项目结算发票上传入口并保留拖拽与点击能力 |
| 2026-08-26 | [changes/2026-08-26-settlement-invoice-real-image-preview.md](changes/2026-08-26-settlement-invoice-real-image-preview.md) | merged（已合入） | 项目结算展示实际上传发票图片、文件名并支持放大 |
| 2026-08-26 | [changes/2026-08-26-payment-review-image-responsive-layout.md](changes/2026-08-26-payment-review-image-responsive-layout.md) | merged（已合入） | 支付复核截图卡片按可用宽度切换布局并避免横向溢出 |
| 2026-08-26 | [changes/2026-08-26-project-settlement-status-alignment.md](changes/2026-08-26-project-settlement-status-alignment.md) | merged（已合入） | 结算状态拆分为未开放、未满额，并将退款处理中调整为已中断 |
| 2026-08-26 | [changes/2026-08-26-table-row-action-layout.md](changes/2026-08-26-table-row-action-layout.md) | merged（已合入） | 项目管理行操作分级收纳，并审计其他列表的按钮数量 |
| 2026-08-26 | [changes/2026-08-26-admin-project-owner-from-procurement-creator.md](changes/2026-08-26-admin-project-owner-from-procurement-creator.md) | merged（已合入） | 项目管理展示采购接口创建人，并支持为受保护项目安全补齐负责人 |
| 2026-08-26 | [changes/2026-08-26-settlement-subscriber-payment-time.md](changes/2026-08-26-settlement-subscriber-payment-time.md) | merged（已合入） | 项目结算认购明细展示认购人员与真实缴款时间 |
| 2026-08-26 | [changes/2026-08-26-settlement-invoice-upload-after-confirmation.md](changes/2026-08-26-settlement-invoice-upload-after-confirmation.md) | merged（已合入） | 项目结算页确认发起结算后才展示发票上传入口 |
| 2026-08-25 | [changes/2026-08-25-multiple-payment-images-cumulative-ocr.md](changes/2026-08-25-multiple-payment-images-cumulative-ocr.md) | merged（已合入） | 同一认购支持多张支付截图追加留存并累计识别金额 |
| 2026-08-25 | [changes/2026-08-25-project-payment-records-review-visibility.md](changes/2026-08-25-project-payment-records-review-visibility.md) | merged（已合入） | 目标项目展示全部缴款记录，待复核可操作，已处理记录只读 |
| 2026-08-25 | [changes/2026-08-25-project-scoped-payment-review-queue.md](changes/2026-08-25-project-scoped-payment-review-queue.md) | merged（已合入） | 支付复核队列只展示目标项目全部待复核缴款记录 |
| 2026-08-25 | [changes/2026-08-25-receiving-code-image-persistence.md](changes/2026-08-25-receiving-code-image-persistence.md) | merged（已合入） | 收款码及图片由本地 API 持久化，已有收款码支持上传或更换真实图片 |
| 2026-08-25 | [changes/2026-08-25-payment-project-actual-context.md](changes/2026-08-25-payment-project-actual-context.md) | merged（已合入） | 支付收款码卡片展示当前认购对应的实际项目、金额与规则数据 |
| 2026-08-25 | [changes/2026-08-25-rule-project-single-selection.md](changes/2026-08-25-rule-project-single-selection.md) | merged（已合入） | 已有认购规则的项目在创建规则时置灰不可选，并禁止重复创建 |
| 2026-08-25 | [changes/2026-08-25-payment-screenshot-real-preview.md](changes/2026-08-25-payment-screenshot-real-preview.md) | merged（已合入） | 员工与财务查看同一张实际支付截图，并支持刷新后恢复和无图状态 |
| 2026-08-25 | [changes/2026-08-25-payment-project-receiving-code.md](changes/2026-08-25-payment-project-receiving-code.md) | merged（已合入） | 支付页按当前认购项目规则展示绑定收款码图片与具体字段 |
| 2026-08-25 | [changes/2026-08-25-receiving-code-image-preview.md](changes/2026-08-25-receiving-code-image-preview.md) | merged（已合入） | 上传后在创建弹窗、收款码列表和规则配置中预览真实图片 |
| 2026-08-25 | [changes/2026-08-25-admin-project-pagination.md](changes/2026-08-25-admin-project-pagination.md) | merged（已合入） | 项目管理列表固定每页展示 10 行并提供分页组件 |
| 2026-08-25 | [changes/2026-08-25-procurement-order-detail-dialog.md](changes/2026-08-25-procurement-order-detail-dialog.md) | merged（已合入） | 在项目详情页通过服务端代理查看匹配的真实采购订单 |
| 2026-08-25 | [changes/2026-08-25-rule-form-derived-field-order.md](changes/2026-08-25-rule-form-derived-field-order.md) | merged（已合入） | 将认购规则的输入字段移至对应推导金额之前 |
| 2026-08-25 | [changes/2026-08-25-admin-project-action-column-fixed.md](changes/2026-08-25-admin-project-action-column-fixed.md) | merged（已合入） | 将项目管理表格的操作列固定在当前视窗右侧 |
| 2026-08-25 | [changes/2026-08-25-procurement-order-project-mapping.md](changes/2026-08-25-procurement-order-project-mapping.md) | merged（已合入） | 将有效采购订单按现有项目字段映射并幂等同步到项目管理列表 |
| 2026-08-25 | [changes/2026-08-25-real-procurement-page-sync.md](changes/2026-08-25-real-procurement-page-sync.md) | merged（已合入） | 将项目管理页的模拟 MCP 同步改为真实采购订单分页只读拉取 |
| 2026-07-09 | [changes/2026-07-09-frontend-current-pages-prd.md](changes/2026-07-09-frontend-current-pages-prd.md) | draft（草稿） | 根据当前前端页面反向生成 PRD，包含已删除 / 隐藏页面边界 |
| 2026-07-09 | [changes/2026-07-09-internal-subscription-platform-reverse-prd.md](changes/2026-07-09-internal-subscription-platform-reverse-prd.md) | draft（草稿） | 根据当前实现反推 PRD 基线 |

## 文档规则

- 基线章节描述当前产品事实，事实冲突时按 `代码 > PRD 基线 > 其他文档` 判断。
- 增量 PRD 初始状态为 `draft`，未经用户确认不得改为 `approved`（评审通过）。
- 已确认并实现的变更最终必须合入基线章节，并在章节末尾维护变更记录。
- 英文标识需保留并补充中文说明，例如 API（应用程序接口）、MCP（模型上下文协议）、OCR（光学字符识别）、RBAC（基于角色的访问控制）。
