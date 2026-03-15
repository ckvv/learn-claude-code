# Simple Fetch Client

[src/simple_fetch_client.ts](src/simple_fetch_client.ts) 是仓库中供 TypeScript 示例复用的最小 OpenAI 兼容客户端。它没有引入 SDK，只封装了当前教程需要的最小请求能力。

## 这个工具做什么

它主要负责：

- 包装 `fetch` 请求
- 向 `/chat/completions` 发送聊天补全请求
- 支持当前示例使用的消息结构和 tool call 结果

这个工具的目标是“够用且容易读懂”，而不是提供完整 API 抽象。

## 运行配置

它从 `.env` 或进程环境读取以下变量：

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `MODEL_ID`

示例：

```bash
export OPENAI_API_KEY=your_api_key
export OPENAI_BASE_URL=https://api.openai.com/v1
export MODEL_ID=gpt-4o-mini
```
