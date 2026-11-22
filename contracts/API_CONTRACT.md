# TRACE v1 API 契约

[OpenAPI 3.1 入口](openapi.yaml) · [JSON Schema 2020-12](schemas/v1.json) · [可复用请求与响应示例](examples/v1.json)

## 通用语义

- 接口版本是 `v1`。业务端点在 `/api/v1` 下，存活探针为 `/health`。成功回包含 `meta` 与 `data`。错误回包含 `meta` 与 `error`，包括 `code`、可读 `message` 及 `retryable`。`meta` 固定包含 `apiVersion`、`source` 和 `requestId`。`X-Request-Id` 是可选 HTTP 关联标识，与 Agent 请求体的 `requestId` 分开。
- 除 `/health` 之外，均要求 Bearer 身份。开发 mock 使用每进程一个由开发者配置的测试令牌，真实服务须由获批的认证层确定所有者。Cookie、用户提供的用户名和路径 ID 都不构成授权证明。错误不返回原始输入、令牌或隐私数据。认证失败为 `401`，授权拒绝为 `403`，越权资源按真实实现约定应以 `404` 处理。
- 默认客户端超时 10 秒，调用可取消。客户端不自动重试写操作。`503` 可由调用方按具体动作退避，`409` 应刷新快照／候选或使用本次操作已验证可复用的 ID，`400`、`413` 和 `415` 应修正请求。取消网络请求无法撤销服务端已提交的业务动作。
- JSON 请求限制为 16 KiB。未声明字段拒绝。开发 mock 按允许来源响应 CORS。真实联调入口接受同机原生客户端，拒绝带 `Origin` 的请求。JSON 响应使用 `Cache-Control: no-store`。来源不匹配时客户端报错，调用方不会自动切换为模拟。

## 端点与验证

| 端点 | 请求和成功响应 | 失败与重试 | 处理限制和契约测试 |
|---|---|---|---|
| `POST /api/v1/agent/message` | `AgentMessageRequest` → `AgentMessageResponse` (`200`)。文本、语言、可选会话 ID 和请求 ID，返回会话／教学工作流、`content.speech` 与 `content.display`。 | 无效输入 `400`，未知会话 `404`，相同业务请求 ID 的不同输入 `409`。网络结果不明时用完全相同的请求体重试。 | Mock 固定答复，无用户输入回显或外发。检查请求重复、会话复用和展示／播报分离。 |
| `POST /api/v1/vision/analyze` | `VisionAnalyzeRequest` → `VisionAnalysisResponse` (`200`)。支持脸颊相对颜色与唇部颜色，携带授权、质量、方法版本、方向和采集时间。输出包含 `predictions`、`confidence`、`quality`，`inconclusive` 时预测为空且置信为空。 | 授权拒绝 `403`，未知会话 `404`，时间过期 `409`。模拟接受过去 30 秒至未来 5 秒的采集时间。撤销或过期后应舍弃结果并重新授权采集。 | API 只接受结构化观测元数据。没有原始图片、视频和关键点上传字段。真实视觉授权除客户端声明外还需服务端策略和验证。检查拒绝、过期、无推理和原始图像字段。 |
| `GET /api/v1/memory/profile` | `MemoryProfileResponse` (`200`)，列出当前身份的已确认偏好。 | 无效请求 `400`。网络中断可重试查询。 | 不隐式复用日志／聊天／摘要。检查未确认候选不可见。 |
| `POST /api/v1/memory/proposals` | `MemoryProposalRequest` → `MemoryProposalResponse` (`201`)。`create` 新建候选，`correct` 用既有 `memoryId`、`expectedVersion` 提议更正。 | 记录不存在 `404`，目标版本变化 `409`。未确认候选有效期 5 分钟。超时后按需重新预览，可能产生另一个未写入的候选。 | 保留候选与已确认记录的状态隔离。检查候选版本、过期与更正冲突。 |
| `POST /api/v1/memory/confirm` | `MemoryConfirmRequest` → `MemoryConfirmationResponse` (`200`)。明确 `confirmed:true` 并绑定候选 ID 和版本。 | 拒绝 `403`，不存在／已清除的候选 `404`，版本冲突、过期及已撤销回执 `409`。对同一候选和版本的成功重试只返回原回执。 | 只写已审核内容。检查并发确认、过期／错误版本、删除后拒绝重放。 |
| `DELETE /api/v1/memory/{memory_id}` | ID → `MemoryDeletionResponse` (`200`)，使相关确认及更正回执作废。 | 未知 ID `404`。同一开发进程内反复删除已删除记录返回同一状态。 | 检查删除后记录消失及旧确认无法恢复。真实持久化按批准的所有者与保留政策执行。 |
| `GET /api/v1/products` | `ProductQuery` → `ProductCatalogResponse` (`200`)。支持 `category`，比较时重复 `ids`，最多 10 个。未知属性为 `null`，无匹配为 `items: []`。 | 无效过滤、重复 ID `400`。安全查询可重试。 | 已验证目录必须带已验证来源和 HTTPS 链接。Mock 只有 `synthetic` 条目。检查筛选、空结果、未知属性和来源。 |
| `GET /health` | `HealthResponse` (`200`)，`status: alive` 与逐项依赖状态。 | 网络失败可重试；进程不可达时无响应。该端点没有身份要求。 | Mock 的 Agent、视觉、记忆、产品依赖均为 `unchecked`。不访问传感器、不发起供应商调用。 |

示例文件包含上述请求结构、所有成功形状以及公用错误示例。产品查询例为 `/api/v1/products?category=lips&ids=fictional-lip-sample`。视觉示例时间为固定测试值，手工联调需要当前采集时间。若以后批准 SwiftData 作为主存储，四项 Memory 操作以相同确认语义实现本地服务，是否启用远端端点另行决定。

`tests/contract/openapi.test.mjs` 校验规范和示例，`tests/integration/mock-api.test.mjs` 在回环端口执行行为场景。Swift 合同测试从同一示例文件读取夹具。

## v0.2.0 独立预览

预览继续使用 mock 服务入口。装载网页时注入每次运行随机的开发令牌，所有 API 回包为 `source: mock`。视觉请求只含合成元数据，摄像头画面留在浏览器预览元素内。

## 本机真实联调

`source: live` 表示来自固定 V1 课程／知识／SQLite 运行副本。普通自由聊天没有已启用的模型，返回 `503 UNAVAILABLE` 且 `retryable: false`。视觉验证输入、授权、会话和时间后返回同样的不可用语义，元数据不足以生成观察结果。目录只返回通过审核且有可追溯 HTTPS 来源的条目。当前固定资料没有合格条目，有效查询返回空列表。健康响应描述本机服务和资料加载，视觉状态为 `unchecked`。

偏好经签名预览及明确确认后写入本机 SQLite。已确认的偏好和课程进度可在同一令牌和 profile 下跨重启读取。候选及 API 回执的有效范围是当前单进程，详细窗口和容量见 [真实服务说明](../docs/engineering/LIVE_BACKEND.md)。现有 OpenAPI、Schema、类型和 Swift Package 可直接消费响应。
