# Web API 接入

`preview/` 是独立中文模拟演练，使用 V1 已验证的视觉资产与现有 V2 API 加载方式。运行 `npm run preview:local`。真实 V1 页面迁移受固定回归失败阻塞。 [集成范围](../../docs/engineering/V020_SCOPE.md)

演练和独立联调消费者使用 `src/services/trace-api.ts`。类型来自 [生成的 v1 类型](../../packages/shared-contracts/v1.ts)。V1 的教学流和媒体继续由原应用维护。

```ts
import { configFromEnv } from './src/services/api-config.ts';
import { TraceApiClient } from './src/services/trace-api.ts';

export function createTraceClient(env: Record<string, string | undefined>, localToken: () => string | undefined) {
  return new TraceApiClient(configFromEnv(env), { token: localToken });
}
```

Vite 消费者传入 `import.meta.env`。模式、URL 和超时来自配置，令牌由运行中的开发者或获批会话层提供。不要把令牌放进 `VITE_` 变量或静态构建。`getHealth()` 无需令牌。取消页面请求时传入 `AbortSignal`；重复发送 Agent 时保持原业务 `requestId`。`TraceApiError` 暴露 HTTP 状态、错误码、关联 ID 和重试提示。

调用方应把 `content.display` 用于界面，`content.speech` 供用户已开启的朗读模式。显示 `meta.source=mock`，不用模拟信息计算模型指标。切换真实端点时同时设置 `VITE_API_MODE=live` 和批准的 `VITE_API_BASE_URL`。两种模式共用相同的方法。 [接口行为](../../contracts/API_CONTRACT.md)
