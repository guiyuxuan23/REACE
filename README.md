# TRACE · 听见你的美

TRACE 面向盲人和低视力用户，把依赖镜子和视觉示范的化妆流程拆成可阅读、可朗读、可重复的步骤。参赛方向是 Apple Human-Centered Care。

[公开网页演练](https://trace-beauty-beyond-sight.lilacpaper10.chatgpt.site)。试用时，先描述晚宴自然妆目标，确认开始，通过键盘或点击完成或跳过每一步，最后读取演练小结。也可预览、确认、更正和删除一条临时偏好。

网页版使用固定演练内容。输入目标和偏好保留在当前页面，刷新后清空。可选摄像头只在用户主动许可后本地预览。站点不上传画面，也不给出真实妆效判断。网页是对课程交互的演练。Swift 网络包与本机后端用于独立的 Apple 接入，公开网页不替代 Apple 原型或实机验收。

## 运行和测试

使用 Node.js 26.10.0：

```sh
npm ci
npm run verify
npm run build:public
python -m http.server 5180 --bind 127.0.0.1 --directory dist
```

浏览器打开 `http://127.0.0.1:5180`。`dist/` 是可部署到静态站点的构建产物，支持在域名根或子目录发布。`npm run preview:local` 是另一个开发入口，使用同机 Node 模拟服务。

本仓包含实际网页、API 契约、回环 mock、真实本机 API 适配和 Swift Codable 客户端。运行 Python 适配需要团队已有的固定 V1 归档，通过 `python3.12 scripts/live.py prepare --archive <V1 ZIP>` 核验。 [后端启动](docs/engineering/LIVE_BACKEND.md) · [Swift 接入](apps/ios/README.md) · [v1 契约](contracts/API_CONTRACT.md)

## 成果范围和披露

TRACE V1 是赛前基础。此仓发布本次 Windows 回归验证后的 V2 联调代码，以及新的浏览器端公开演练入口。既有 V1 归档、课程和产品资料未重新分发，原网页插画未随公开版发布。参赛展示应按活动规则区分既有基础和活动期间完成的工作。

本仓的 TRACE 源码按 [Apache License 2.0](LICENSE) 发布。依赖、系统服务和工具的说明见 [第三方资源与 AI 工具披露](THIRD_PARTY_NOTICES.md)。
