# Roop

A smol, Effect-native agents layer. The agent is the protocol: an agent is exposed as an Effect
`RpcGroup`, and capability discovery is derived from the same live values the agent runs with — a
`Toolkit`, a model catalog, and a skill list.

Built from replaceable Effect services, so models, tools, storage, and transports can be swapped
without changing the loop.

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
- `@roop/agent-node` — Node adapter: DeepSeek model catalog and CLI.
- `@roop/coding-harness` — example: a coding agent (`readFile`/`writeFile`/`listFiles`/`bash` tools)
  served over Effect RPC, with a CLI client.

## Scripts

- `pnpm typecheck` — typecheck all packages.
- `pnpm test` — run all tests (a live DeepSeek smoke test runs when `DEEPSEEK_API_KEY` is set).
- `pnpm --filter=@roop/agent-node cli` — chat with an agent over DeepSeek.
- `pnpm --filter=@roop/coding-harness cli server [port]` — serve the coding harness over RPC (HTTP).
- `pnpm --filter=@roop/coding-harness cli client [url]` — chat with it over RPC.
