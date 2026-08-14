# Roop

A smol, Effect-native agents layer. The agent is the protocol: an agent is exposed as an Effect
`RpcGroup`, and capability discovery is derived from the same live values the agent runs with — a
`Toolkit`, a model catalog, and a skill list.

Built from replaceable Effect services, so models, tools, storage, and transports can be swapped
without changing the loop. Agents are composed from plugins — values contributing tools, models,
skills, and prompt fragments — and `subagent(...)` turns a plugin list into a delegation tool.

Start here:

- [`SPEC.md`](SPEC.md) — design.
- [`packages/agent/src/Agent.ts`](packages/agent/src/Agent.ts) — the kernel service.
- [`packages/agent-rpc/src/AgentRpc.ts`](packages/agent-rpc/src/AgentRpc.ts) — the protocol.
- [`packages/agent-node/src/Cli.ts`](packages/agent-node/src/Cli.ts) — a readline CLI over DeepSeek.
- [`packages/coding-harness/src/Cli.ts`](packages/coding-harness/src/Cli.ts) — a coding harness
  served over RPC.

## Packages

- `@roop/agent` — kernel: agent loop, model catalog, session store, capability derivation,
  agent-as-tool. Imports only `effect`.
- `@roop/agent-rpc` — `RpcGroup` protocol, server layer, HTTP transport helpers.
- `@roop/agent-node` — Node adapter: a readline CLI over the kernel.
- `@roop/plugin-openai` — any OpenAI-compatible API (OpenAI, DeepSeek, local) as a model plugin.
- `@roop/plugin-claude` — your Claude Code subscription via the local `claude` CLI.
- `@roop/plugin-codex` — your ChatGPT subscription via the local `codex` CLI.
- `@roop/plugin-web` — `webFetch` tool over the Effect `HttpClient`.
- `@roop/plugin-todo` — `writeTodos` planning tool with a prompt nudge.
- `@roop/plugin-skills` — serves a directory of `SKILL.md` files through a `skill` tool.
- `@roop/coding-tools` — coding toolkit (`readFile`/`writeFile`/`listFiles`/`bash`), a plain library
  composed into an agent at build time.
- `@roop/coding-harness` — the composition: kernel + coding tools + DeepSeek behind an RPC HTTP
  server.
- `@roop/coding-tui` — a pi-like terminal UI over `@mariozechner/pi-tui` with slash commands
  (`/models`, `/skills`, `/tools`, `/new`, `/help`); talks to the server only through the RPC client
  (guarded by a test).

## Scripts

- `pnpm typecheck` — typecheck all packages.
- `pnpm test` — run all tests (a live DeepSeek smoke test runs when `DEEPSEEK_API_KEY` is set).
- `pnpm --filter=@roop/agent-node cli` — chat with an agent over DeepSeek.
- `pnpm --filter=@roop/coding-harness serve [port]` — serve the coding agent over RPC (HTTP).
- `pnpm --filter=@roop/coding-tui start [url]` — the pi-like TUI client.
