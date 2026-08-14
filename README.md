# Roop

A smol, Effect-native agent runtime. The agent is the protocol: an agent is exposed as an Effect
`RpcGroup`, and capability discovery is derived from the same live values the agent runs with — a
`Toolkit`, a model catalog, and a skill list.

Built from replaceable Effect services, so providers, tools, storage, and frontends can be swapped
without changing the loop.

Start here:

- [`SPEC.md`](SPEC.md) — design: kernel vs. protocol, schema-derived advertisement.
- [`packages/agent/src/Agent.ts`](packages/agent/src/Agent.ts) — the kernel service.
- [`packages/agent-rpc/src/AgentRpc.ts`](packages/agent-rpc/src/AgentRpc.ts) — the protocol.
- [`packages/agent-rpc/test/AgentRpc.test.ts`](packages/agent-rpc/test/AgentRpc.test.ts) —
  end-to-end through `RpcTest`.

## Packages

- `@roop/agent` — kernel: agent loop, model catalog, session store, capability derivation.
- `@roop/agent-rpc` — `RpcGroup` protocol and server layer over the kernel.

## Scripts

- `pnpm typecheck` — typecheck all packages.
- `pnpm test` — run all tests (a live DeepSeek smoke test runs when `DEEPSEEK_API_KEY` is set).
