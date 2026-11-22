# iOS 网络 Package

`TraceAPI` 是面向未来 SwiftUI 应用的网络库，声明 iOS 16 和 macOS 13 最低部署目标。使用 `URLSession`、`Codable`、async/await、错误枚举和可替换的 URLSession。SwiftUI 界面和媒体能力由各自应用 target 接入。

```swift
import Foundation
import TraceAPI

func makeTraceClient() throws -> TraceAPIClient {
    let configuration = try TraceAPIConfiguration(
        baseURL: URL(string: "http://127.0.0.1:8000")!, mode: .live
    )
    return TraceAPIClient(configuration: configuration) {
        ProcessInfo.processInfo.environment["TRACE_LIVE_TOKEN"]
    }
}

func startLesson(with client: TraceAPIClient) async throws -> AgentReply {
    let reply = try await client.sendAgentMessage(AgentMessageRequest(
        requestId: UUID().uuidString, locale: .simplifiedChinese, text: "我想画个十五分钟的自然日常妆"
    ))
    return reply.data
}
```

先在同一台 Mac 启动 [真实后端](../../docs/engineering/LIVE_BACKEND.md)。把 Package 作为本地依赖加入 Xcode 应用 target。在本地 Xcode Scheme 的 Run 环境变量中注入与后端相同的 `TRACE_LIVE_TOKEN`，避免提交开发令牌。Mac 开发机可执行 `swift test --package-path apps/ios`，测试读取 [同一份联调示例](../../contracts/examples/v1.json)。

界面显示 `reply.content.display.text`，将 `reply.content.speech` 交给应用自己的播报机制。下一轮沿用 `reply.session.id`，为每个新动作生成新的 `requestId`。同一个请求在网络结果不明时复用原 ID 和同一请求体。`Task.cancel()` 可以放弃等待。偏好先 `proposeMemory`，向用户展示候选，明确同意后再 `confirmMemory`。视觉返回 `503 UNAVAILABLE` 时可继续文字课程。

开发模拟依旧使用 `.mock` 和 `http://127.0.0.1:8001`。对应的令牌独立配置。

物理 iPhone 的 `localhost` 指向手机自身。开发 mock 只绑定回环且客户端的 `.mock` 只接受回环地址。联网真机接入需单独批准的 HTTPS 服务、身份与访问控制，保持系统的传输安全策略。当前 Windows 验证状态见 [验证报告](../../docs/engineering/VERIFICATION.md)。
