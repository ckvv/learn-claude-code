## Repository expectations

- Document public utilities in `docs/` when you change behavior.
- Ask for confirmation before adding new production dependencies.

# Repository Guidelines

## Project Structure & Module Organization

This repository mirrors AI agent patterns in two tracks:

- `agents/`: Python tutorial reference files, from `s01_agent_loop.py` through `s12_worktree_task_isolation.py`, plus `s_full.py`.
- `src/`: TypeScript ports and shared utilities, currently including `s01_agent_loop.ts`, `s02_tool_use.ts`, and `simple_fetch_client.ts`.
- `docs/`: Documentation for public TypeScript utilities. Update this when behavior or usage changes.
- Root config files: `package.json`, `tsconfig.json`, `vite.config.ts`, and local environment settings in `.env`.

Keep new TypeScript examples in `src/` and match the Python chapter naming where possible, for example `s02_tool_use.ts`.

## Build, Test, and Development Commands

- `pnpm install`: install Node dependencies.
- `pnpm 1`: run the TypeScript `s01` agent loop with `.env` loaded.
- `pnpm 2`: run the TypeScript `s02` tool-use example with `.env` loaded.
- `pnpm 3`: run the TypeScript `s03` todo-write example with `.env` loaded.
- `pnpm full`: run the TypeScript `s_full` reference agent with `.env` loaded.
- `pnpm check`: run the repository-wide validation flow, including formatting, linting, and type checks via `vp check --fix`.

Python examples are reference code only at the moment; there is no repo-managed Python dependency file or runner script.

## Coding Style & Naming Conventions

Use TypeScript with strict typing and ES module imports. The existing codebase uses double quotes, semicolons, `const` by default, and descriptive camelCase names for variables and functions. Keep chapter files prefixed with `sNN_` to preserve parity with `agents/`.

These examples are executed directly with Node's native `.ts` support (`node --env-file=.env ...`), so avoid TypeScript syntax that requires transpilation. In particular, do not use parameter properties like `constructor(private readonly root: string)` because Node strip-only mode does not support them.

When porting Python chapters to TypeScript, keep these migration pitfalls in mind:

- `src/simple_fetch_client.ts` only supports string `content` messages, so Anthropic-style mixed content arrays such as `tool_result` plus injected reminder blocks must be adapted into plain chat messages when targeting the current OpenAI-compatible client.
- Strict linting rejects stringifying arbitrary `unknown` tool inputs with `String(value)` because that can hide `[object Object]` mistakes. Narrow unknown values explicitly before converting them into strings.

Prefer small reusable utilities in `src/`, and document public utilities in `docs/` when their API or behavior changes.

## Testing Guidelines

There is no dedicated automated test framework configured yet. For now:

- run `pnpm check` before submitting changes;
- exercise affected TypeScript flows manually, for example with `pnpm 1` or `pnpm 2`;
- include clear reproduction steps in the PR when changing runtime behavior.

Use `pnpm check` as the default validation command instead of invoking standalone TypeScript checks such as `pnpm exec tsc --noEmit`.

If you add tests later, place them near the relevant module or under a top-level `tests/` directory and name them after the target module.

## Commit & Pull Request Guidelines

Git history currently contains only an initial commit, so no strict convention is established yet. Use short imperative commit subjects, for example `Add s02 TypeScript tool-use example`.

Pull requests should include:

- a brief summary of the behavior change;
- linked issues or learning goals when applicable;
- command output or screenshots for user-visible changes;
- notes about required `.env` variables or setup changes.
