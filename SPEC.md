# Roop v2 — candidate: rpc-first

The agent is the protocol. Roop exposes an agent as an Effect `RpcGroup` and derives capability
discovery from the same live values the agent runs with: a `Toolkit`, a model catalog, and a skill
list. Nothing about the protocol is hand-written JSON.

## Packages

- `packages/agent` — the kernel. Plain Effect services with no RPC dependency.
- `packages/agent-rpc` — the protocol. One `RpcGroup` implemented over the kernel.

## The kernel

Four services, all replaceable via layers.

- `Agent` — `prompt` (a stream of `AgentEvent`), `interrupt`, `history`, `capabilities`. Built by
  `AgentLive(toolkit)`.
- `ModelCatalog` — `list`, `defaultModelId`, `resolve(id?)`. Built by `ModelCatalogLive(specs)` from
  `{ id, provider, description?, layer }` entries. Adding an entry changes what the protocol
  advertises and what `resolve` can serve.
- `SessionStore` — `load`/`save` of a session's decoded `Prompt.Message` list. A memory
  implementation ships (`SessionStoreMemory`); a durable one is a new layer.
- `Skills` — a list of `{ id, description }`, advertised but not executed. Optional.

The loop lives in `agentLoop.ts` (camelCase, leaf helper): `Chat.fromPrompt` seeded from the
session, `chat.streamText({ prompt, toolkit, concurrency: "unbounded" })` per turn, repeat while a
turn produced tool calls. A `Deferred` per active session supports cooperative interrupt; the loop
races each turn against it and finishes with `reason: "interrupted"`.

## The protocol

```
RpcGroup "Agent"
  Capabilities  {}                      -> Capabilities
  Prompt        { prompt, sessionId?, modelId? } -> AgentEvent (stream)
  Interrupt     { sessionId }           -> void
  GetHistory    { sessionId }           -> Session
```

`Prompt` streams `AgentEvent`: `TextDelta`, `ReasoningDelta`, `ToolCall`, `ToolResult`,
`Finish{ completed | failed | interrupted }`. Failures inside a run are folded into `Finish.failed`;
only protocol-level faults (unknown model, busy session) use the RPC error channel, typed as
`ModelNotFound | SessionBusy`.

`AgentRpcServer` is thin: every handler is a one-line call into `Agent`. `RpcTest.makeClient` drives
the whole surface in-process for tests.

## Schema-derived advertisement

`Capabilities.tools` is derived from the live toolkit. Each entry is

```
{ name: tool.name, description: tool.description, parameters: Tool.getJsonSchema(tool) }
```

`Tool.getJsonSchema` is the same conversion Effect AI uses when it sends the tool to a provider. So
the JSON Schema a client reads is the JSON Schema the model saw — one schema, one derivation, two
audiences. Models come from the catalog's entries, skills from the `Skills` service, and
`defaultModelId` from the catalog's first entry.

## Is RPC the only interface, or a view over a kernel?

A view. The kernel services are ordinary Effect services: an Effect program can call `Agent.prompt`
directly and get the same stream. The RPC group adds a serialization boundary and a typed client,
nothing more. `RpcTest` proves this by connecting a generated client to the same handler layer a
real server would use.

This ordering matters: the protocol is derived from the services, not the reverse. Capability
discovery is not a separate registry to keep in sync — it reads the toolkit, catalog, and skills the
agent is already wired with.

## What schema-derived advertisement buys

1. Typed clients. `RpcClient.FromGroup<typeof AgentRpc>` gives a client whose method shapes are the
   protocol schemas. Capabilities is a normal schema, so its payload type is derived from the same
   source as the wire encoding.
2. Tool ads for the model. Providers need tool JSON Schema; clients need tool ads. Both come from
   `tool.parametersSchema`. When a tool changes, the model call and the advertisement change
   together.
3. Extensibility. Add a catalog entry, a toolkit tool, or a skill layer and the advertised surface
   changes with it. No snapshot, no codegen, no second source of truth.

## Where it fights Effect AI's own Toolkit abstraction

Effect AI already advertises tools to models. The RPC layer re-derives the same JSON Schema for
clients, so there are two advertising channels but one schema source — that part cooperates. The
friction is typing:

- `Toolkit` is a _value_ whose precise TypeScript types are
  `Tools extends Record<string, Tool.Any>`. The RPC group is a fixed, serializable schema, so those
  precise tool types cannot cross the wire. Clients receive `parameters: unknown` (the JSON Schema),
  not a compile-time checked call surface. `AgentLiveToolkit` erases to
  `WithHandler<Record<string, Tool.Any>>` at the boundary.
- Effect AI keeps tool handlers in Effect context (`Toolkit.toLayer`); Roop re-wraps the resolved
  `WithHandler` as a plain value so the loop and capability derivation share it. If Effect AI grows
  a `Toolkit` service tag, `AgentLive` becomes a one-line `yield*`.
- Session history has two projections: the live `Chat.history` Ref used for model context and the
  decoded `Prompt.Message` list served by `GetHistory`. The loop persists after every turn, so they
  only diverge within a turn.

## Deliberate cuts

- No session queueing. Two concurrent prompts on one session: the second fails with `SessionBusy`.
  Callers that need FIFO serialize at their own layer.
- Preliminary tool results are skipped; only the final `ToolResult` is streamed.
- No transport demo. The tests exercise the protocol through `RpcTest`, which is the same handler
  layer a WebSocket or HTTP server would mount.
