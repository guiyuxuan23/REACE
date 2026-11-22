# 第三方资源与 AI 工具披露

| 工具或资源 | 实际用途 |
|---|---|
| OpenAI Codex | 协助审计、前后端联调代码、测试、文档及公开版打包。公开演练里的课程和视觉示例在浏览器本地执行。 |
| TypeScript、Node.js | 编译及运行本地 Web 工具，版本见 `package.json` 和 `package-lock.json`。 |
| Ajv、ajv-formats、Swagger Parser、openapi-typescript | JSON Schema、OpenAPI 与生成客户端类型的检查。没有将这些 npm 库打进公开站点。 |
| CPython、FastAPI、Pydantic、Uvicorn、SQLite | 本机真实适配。Python 直接及传递依赖见 V1 已有锁文件。 |
| Apple Foundation / URLSession、Swift Package Manager | Swift 网络接口。SwiftUI 界面、Vision、Core ML 和签名属于独立 Apple 原型的验收范围。 |
| 浏览器语音合成与摄像头 API | 按需调用可用的本机中文音色，用户主动允许后提供本地画面预览。 |
| TRACE V1 既有基础 | V2 本机适配复用固定 V1 课程、产品知识库及确认式 SQLite 存储。`backend/live/upstream-files.json` 提供路径和哈希。 |

第三方依赖保留各自原始许可证。公开网页没有嵌入外部图片、字体、分析 SDK 或模型 API。参赛海报材料由团队另行提交。
