# ROOP

ROOP is an Effect-native runtime for building composable coding agents.

The core is a small agent service: it resolves a model, runs a tool loop, stores session history,
exposes capabilities, and can be reached through Effect RPC. Models, tools, storage, skills, and
transports are replaceable services, so the agent kernel does not need to know where any particular
capability comes from.

Plugins contribute the pieces that make an agent useful. A plugin can provide tools, model adapters,
skills, prompt fragments, or a subagent. The coding harness is one composition of those parts:
coding tools, a model, a session store, and RPC clients for the terminal and web.

```text
plugins
   ↓
agent kernel
   ↓
Effect RPC
   ├─ terminal client
   └─ web client
```

The kernel is deliberately portable. It depends only on `effect` and `effect/unstable/ai`, which
allows the same agent logic to run in Node, Workers, and other platform adapters.

## Direction

ROOP is moving toward an agent runtime with explicit turn and step boundaries, composable
interception points, durable execution history, and plugins that can extend the loop without editing
it.

Longer term, the project is also a place to explore inspectable agent workflows. Instead of calling
tools one at a time, an agent could describe a multi-step task as a typed program: search files,
prepare patches, request approval, apply changes, and run tests. A runtime could inspect that
program, check its capabilities and policies, show a preview, and then execute or resume it.

That work is exploratory. The current focus is a reliable, portable agent kernel and the seams that
let richer runtime behavior be added without turning the loop into a collection of special cases.

## Try it

Install dependencies and typecheck the workspace:

```sh
pnpm install
pnpm typecheck
```

Run the simple Node client:

```sh
pnpm --filter=@roop/agent-node cli
```

Run the coding harness over RPC:

```sh
pnpm --filter=@roop/coding-harness serve
```

Start with [`packages/agent/src/Agent.ts`](packages/agent/src/Agent.ts) for the kernel,
[`packages/agent-rpc/src/AgentRpc.ts`](packages/agent-rpc/src/AgentRpc.ts) for the protocol, and
[`packages/coding-harness/src/Serve.ts`](packages/coding-harness/src/Serve.ts) for a complete
composition.
