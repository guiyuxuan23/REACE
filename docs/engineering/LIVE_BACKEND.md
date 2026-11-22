# V1 真实后端与 Swift 本机联调

## 运行边界

V2 复用 V1 固定提交 `b73f5e701d37a9c17623b6209f128b41bcb229ee` 的课程控制器、会话、知识库、产品审核及 SQLite。`backend/live/` 只注册 v1 契约中的八个操作。V1 旧站管理、日志、媒体和硬件 HTTP 路由不在此入口。网页预览通过原入口使用 mock，便于并行开发和演练。

| 模块 | 输入与输出 | 状态与失败 |
|---|---|---|
| `scripts/live.py` | 固定 SHA-256 清单、V1 ZIP、锁定的 CPython 3.12 环境 | 只提取允许的原文件至 `.trace-live/`。文件缺失或哈希变化时停止。Uvicorn 固定 `127.0.0.1`、单进程。 |
| `backend/live/entrypoint.py` | 固定原文件与独立 SQLite 路径，构建 Agent、知识和存储 | V1 原模型配置不参与应用组装。V2 只调用有真实实现的本机逻辑。 |
| `backend/live/api.py`、`contracts.py` | HTTP、Bearer、受限 JSON，返回固定 `live` 信封 | 保留 `X-Request-Id`、拒绝未知字段和大于 16 KiB 的 JSON。失败返回稳定错误类型。 |
| `backend/live/coaching.py` | 自然妆目标、同一会话与课程控制命令，返回显示和播报内容 | 复用 `CoachingController`。草稿 → 教学中 ↔ 暂停 → 完成。草稿课程从第一条结果开始披露。普通聊天、远程推理返回不可用。 |
| `backend/live/preferences.py` | 本机身份、候选、确认和版本，返回可读偏好记录 | 调用 V1 已签名候选、SQLite 事务、删除和回执作废。保存前只在内存保留候选。 |

### 身份、权限与保留

联调实例在一台 Mac 或 Windows 上运行。校验回环 Host 及 Bearer。浏览器 `Origin` 被拒绝，代理头不参与身份或路由。每个实例只接受开发者设置的高熵 `TRACE_LIVE_TOKEN`，所有者由令牌哈希生成。请求体无法指定所有者。换令牌会创建不同身份，旧数据仍隔离在原所有者下。测试使用随机的独立令牌和 SQLite profile。

SQLite 路径为 `.trace-live/AccessibleBeautyAgent/data/users/v2-<profile>.sqlite`。仅用于本机联调，不属于打包内容。已确认偏好保存至用户主动删除。课程数字进度遵循 V1 的 30 天恢复范围，迁移和正常关闭时清理过期课程。未记录完整聊天、原始图像、视频、传感器数据或供应商调用。实际的个人偏好可在客户端通过同一身份审核、纠正、删除。SQLite 由机器的本地访问权限保护，无独立应用加密。正式账户、远端访问和远端存储另行设计和验证。

### 重试与失败

- Agent 成功回执在当前进程保留最近 1,024 个、最长两小时。完全相同的业务请求返回原结果，改变内容返回 `409`。V1 已存教学操作沿用终端传入的 `event_id`，正常服务进程内的并发轮次经同一把锁依次提交。
- 偏好候选有效五分钟，最多 100 条待确认。已确认记录最多 256 条。回执和重复删除在当前进程各保留最近 512 项，重启后从已确认档案读取。取消客户端等待不能回滚已完成的事务。
- 视觉仅接收契约规定的元数据。拒绝未授权、过期及额外图像字段。合法请求返回 `503 UNAVAILABLE`，`retryable: false`，应用可继续文字课程。真实分析需要设备侧 Vision/Core ML 和真实采集验证。
- 产品目录只接收 V1 明确人工审核、真实命名、有 HTTPS 来源的条目。当前固定目录的 14 项均为草稿，有效查询返回空列表。

## 接手、验证与回退

按 [Swift 接手指南](../../apps/ios/README.md) 对接 Package。开发者可在 Mac 使用 `swift test --package-path apps/ios`。联调起点为 `http://127.0.0.1:8000`，真实模式使用 `.live`。同机回环可供 Xcode 模拟器验证，真实 iPhone 的网络地址需目标环境另验。

在准备 Python 后端并运行 `npm ci` 后，执行 `python3.12 scripts/test-live.py`。它在独立端口将每项 HTTP 回包交给共享 JSON Schema 验证，重启服务后继续校验 SQLite 和身份隔离。启动回环服务以独立流程完成，不对原 V1 网络断言放宽。另运行 `npm run verify` 与 `npm run build:preview`。 [已执行验证](VERIFICATION.md)

本公开仓库提供适配器和校验清单。团队有权使用的固定 V1 归档通过 `python3.12 scripts/live.py prepare --archive <V1 ZIP>` 传入，验证后生成独立的本机运行副本。
