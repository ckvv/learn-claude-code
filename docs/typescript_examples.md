# TypeScript 示例说明

这个仓库已经为所有教程章节提供了对应的 TypeScript 版本，源码位于 [src/](/Users/chenkai/Desktop/learn-claude-code/src)。这些示例的目标不是抽象成框架，而是尽量保持逐章可运行、结构清晰、方便和 Python 原版对照。

## 设计目标

- 章节优先：每一章尽量保持独立，可单独运行
- 对照优先：TypeScript 结构尽量贴近 Python 原章节
- 抽象克制：只有在 TypeScript 侧已经存在公共能力时才复用

## 章节清单

| 章节   | 主题                      | TypeScript 文件                                                                                                   | 运行命令    |
| ------ | ------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------- |
| `s01`  | 最小 Agent Loop           | [src/s01_agent_loop.ts](/Users/chenkai/Desktop/learn-claude-code/src/s01_agent_loop.ts)                           | `pnpm 1`    |
| `s02`  | 工具调用与分发            | [src/s02_tool_use.ts](/Users/chenkai/Desktop/learn-claude-code/src/s02_tool_use.ts)                               | `pnpm 2`    |
| `s03`  | Todo 管理                 | [src/s03_todo_write.ts](/Users/chenkai/Desktop/learn-claude-code/src/s03_todo_write.ts)                           | `pnpm 3`    |
| `s04`  | Subagent                  | [src/s04_subagent.ts](/Users/chenkai/Desktop/learn-claude-code/src/s04_subagent.ts)                               | `pnpm 4`    |
| `s05`  | Skill Loading             | [src/s05_skill_loading.ts](/Users/chenkai/Desktop/learn-claude-code/src/s05_skill_loading.ts)                     | `pnpm 5`    |
| `s06`  | Context Compact           | [src/s06_context_compact.ts](/Users/chenkai/Desktop/learn-claude-code/src/s06_context_compact.ts)                 | `pnpm 6`    |
| `s07`  | Task System               | [src/s07_task_system.ts](/Users/chenkai/Desktop/learn-claude-code/src/s07_task_system.ts)                         | `pnpm 7`    |
| `s08`  | Background Tasks          | [src/s08_background_tasks.ts](/Users/chenkai/Desktop/learn-claude-code/src/s08_background_tasks.ts)               | `pnpm 8`    |
| `s09`  | Agent Teams               | [src/s09_agent_teams.ts](/Users/chenkai/Desktop/learn-claude-code/src/s09_agent_teams.ts)                         | `pnpm 9`    |
| `s10`  | Team Protocols            | [src/s10_team_protocols.ts](/Users/chenkai/Desktop/learn-claude-code/src/s10_team_protocols.ts)                   | `pnpm 10`   |
| `s11`  | Autonomous Agents         | [src/s11_autonomous_agents.ts](/Users/chenkai/Desktop/learn-claude-code/src/s11_autonomous_agents.ts)             | `pnpm 11`   |
| `s12`  | Worktree + Task Isolation | [src/s12_worktree_task_isolation.ts](/Users/chenkai/Desktop/learn-claude-code/src/s12_worktree_task_isolation.ts) | `pnpm 12`   |
| `full` | Full Reference Agent      | [src/s_full.ts](/Users/chenkai/Desktop/learn-claude-code/src/s_full.ts)                                           | `pnpm full` |

## 运行前提

这些文件通过 Node 原生 `.ts` 支持直接运行，依赖以下环境变量：

- `OPENAI_API_KEY`
- `OPENAI_BASE_URL`
- `MODEL_ID`

通常在项目根目录准备 `.env`，然后直接执行对应脚本即可。

## 实现约束

- 避免使用需要额外转译的 TypeScript 语法
- 保持章节单文件、自包含的教学风格
- 非必要不抽离通用工具
- 如果公共 TypeScript 工具行为变化，记得同步更新 [docs/](/Users/chenkai/Desktop/learn-claude-code/docs)

## 验证方式

修改任意示例后，统一使用以下命令检查：

```bash
pnpm check
```

如果你要查看公共请求客户端的说明，见 [docs/simple_fetch_client.md](/Users/chenkai/Desktop/learn-claude-code/docs/simple_fetch_client.md)。
