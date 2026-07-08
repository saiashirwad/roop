# Roop

> [!WARNING]
> Roop is a work in progress. It is experimental and not production-ready. APIs and
> behavior may change without notice.

A smol, Effect-native agent runtime.

Roop is built from replaceable Effect services, so providers, tools, storage, subagents, and frontends can be swapped or added without changing the core loop.

Start here:

- [`packages/core/src/Agent.ts`](packages/core/src/Agent.ts)
- [`packages/pack/src/pack.ts`](packages/pack/src/pack.ts)
- [`packages/rpc/src/AgentRpc.ts`](packages/rpc/src/AgentRpc.ts)
- [`apps/server/src/main.ts`](apps/server/src/main.ts)
