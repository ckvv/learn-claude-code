# learn-claude-code

一个用来拆解 AI Coding Agent 核心模式的学习仓库。它保留了原始 Python 教学示例，并提供逐章对应的 TypeScript 版本，方便对照理解 agent 如何从最小 loop 演化到工具调用、任务系统、多 agent 协作和 worktree 隔离。


| 章节                      | 文件                                                                                                              |
| -------------------------| ----------------------------------------------------------------------------------------------------------------- |
| 最小 Agent Loop           | [src/s01_agent_loop.ts](src/s01_agent_loop.ts)                           |
| 工具调用与分发              | [src/s02_tool_use.ts](src/s02_tool_use.ts)                               |
| Todo 管理                 | [src/s03_todo_write.ts](src/s03_todo_write.ts)                           |
| Subagent                  | [src/s04_subagent.ts](src/s04_subagent.ts)                               |
| Skill Loading             | [src/s05_skill_loading.ts](src/s05_skill_loading.ts)                     |
| Context Compact           | [src/s06_context_compact.ts](src/s06_context_compact.ts)                 |
| Task System               | [src/s07_task_system.ts](src/s07_task_system.ts)                         |
| Background Tasks          | [src/s08_background_tasks.ts](src/s08_background_tasks.ts)               |
| Agent Teams               | [src/s09_agent_teams.ts](src/s09_agent_teams.ts)                         |
| Team Protocols            | [src/s10_team_protocols.ts](src/s10_team_protocols.ts)                   |
| Autonomous Agents         | [src/s11_autonomous_agents.ts](src/s11_autonomous_agents.ts)             |
| Worktree + Task Isolation | [src/s12_worktree_task_isolation.ts](src/s12_worktree_task_isolation.ts) |
| Full Reference Agent      | [src/s_full.ts](src/s_full.ts)    

## 这个仓库适合谁

- 想从底层理解 agent loop，而不是直接依赖完整框架的人
- 想对照 Python / TypeScript 两种实现的人
- 想基于最小原型继续改造自己的 coding agent 的人

## 你能在这里看到什么

- `agents/`：按章节拆分的 Python 教学代码
- `src/`：与 Python 章节一一对应的 TypeScript 可运行实现
- `docs/`：公共 TypeScript 工具和实现说明

核心目标不是封装成库，而是尽量保持每章自包含、可直接运行、方便阅读。

## 上手指南

### 安装依赖

要求：Node.js 24+、pnpm。

```bash
pnpm install
```

### 配置环境变量

TypeScript 示例通过 OpenAI 兼容接口运行，读取以下变量：

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `MODEL_ID`

示例：

```bash
export OPENAI_API_KEY=your_api_key
export OPENAI_BASE_URL=https://api.openai.com/v1
export MODEL_ID=gpt-4o-mini
```

### 运行一个例子

```bash
pnpm 1
```

这会执行最小 agent loop 示例：[src/s01_agent_loop.ts](src/s01_agent_loop.ts)

### 做一次完整检查

```bash
pnpm check
```

仓库默认使用 `pnpm check` 执行格式化、lint 和类型检查；不需要额外运行 `pnpm exec tsc --noEmit`。

## 目录结构

```text
.
├── agents/                         # Python 教学示例
├── src/                            # TypeScript 对照实现
├── docs/                           # 公共工具与实现说明
├── README.md
├── package.json
├── tsconfig.json
└── vite.config.ts
```

## TypeScript 版本的实现取舍

相对 Python 原版，TypeScript 侧做了这些明确约束：

- 使用 OpenAI 兼容的 `fetch` 客户端，而不是 Anthropic SDK
- 只保留少量已经抽出的公共能力，例如 [src/simple_fetch_client.ts](src/simple_fetch_client.ts)
- 优先保持章节单文件、自包含的教学风格

这意味着代码更偏“教程式可读性”，而不是“工程化封装优先”。

## 日志说明

`[src/simple_fetch_client.ts](src/simple_fetch_client.ts)` 会将请求消息和响应内容写入仓库根目录的 `request.log`，便于调试接口交互。

每次 Node 进程启动并加载该模块时，`request.log` 都会先被清空，然后在后续请求中持续追加新的日志内容。

## 开发约束

- 这些 TypeScript 示例直接使用 Node 原生 `.ts` 支持运行，避免使用需要额外转译的语法
- 尽量保持和 Python 原章节结构一致，方便逐章对照
- 非必要不抽离公共方法
- 当公共 TypeScript 工具的行为发生变化时，同步更新 [docs/](docs)

## 相关文档

- [docs/typescript_examples.md](docs/typescript_examples.md)
- [docs/simple_fetch_client.md](docs/simple_fetch_client.md)
