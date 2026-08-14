# Roop

A smol, Effect-native agents layer. One kernel, one protocol, one Node adapter.

## Packages

- `packages/agent` — the kernel. Plain Effect services over `effect/unstable/ai`; imports nothing
  platform-specific (`test/portability.test.ts` guards imports) and the core suite runs inside real
  workerd (`test-workerd/`).
- `packages/agent-rpc` — the protocol. One `RpcGroup` over the kernel, plus HTTP transport helpers.
- `packages/agent-node` — the Node adapter. DeepSeek model catalog, a readline CLI, and the live
  smoke test.
- `packages/coding-harness` — a worked example. Four coding tools (`readFile`, `writeFile`,
  `listFiles`, `bash`) behind an agent served over the RPC group, plus a CLI client. The tools
  declare their service `dependencies` (`FileSystem`, `ChildProcessSpawner`), so the toolkit's
  handler requirements flow through `AgentLiveToolkit` unchanged.

## The kernel

Four replaceable services.

- `Agent` — `prompt` (a stream of `AgentEvent`), `interrupt`, `history`, `capabilities`. Built by
  `AgentLive(toolkit, { systemPrompt? })`.
- `ModelCatalog` — `list`, `defaultModelId`, `resolve(id?)`. Built by `ModelCatalogLive(specs)` from
  `{ id, provider, description?, layer }` entries; adding an entry changes both what the protocol
  advertises and what `resolve` serves.
- `SessionStore` — `load`/`save` of a session's `Prompt.Message` list. `SessionStoreMemory` ships; a
  durable store is a new layer.
- `Skills` — `{ id, description }` list, advertised but not executed. Optional.

`agentLoop.ts` drives Effect's `Chat`: seed from the session,
`chat.streamText({ prompt, toolkit, concurrency: "unbounded" })` per turn, repeat while a turn
produced tool calls. `maxTurns` caps the loop; a `Deferred` per active session gives cooperative
interrupt. `agentTool.ts` wraps one `Agent` as an Effect AI `Tool` so agents compose.

## The protocol

```
RpcGroup "Agent"
  Capabilities  {}                                 -> Capabilities
  Prompt        { prompt, sessionId?, modelId?, maxTurns? } -> AgentEvent (stream)
  Interrupt     { sessionId }                      -> void
  GetHistory    { sessionId }                      -> Session
```

`AgentEvent` is a schema union: `TextDelta`, `ReasoningDelta`, `ToolCall`, `ToolResult`,
`Finish{ completed | failed | interrupted | stopped }`. Run failures fold into `Finish.failed`; only
protocol faults (`ModelNotFound`, `SessionBusy`, `RunNotFound`, `SessionNotFound`) use the typed
error channel.

`AgentRpcServer` is thin — every handler is one line into `Agent`. `AgentRpcHttp.ts` mounts the
group over HTTP (`RpcServer.layerHttp` + ndjson) and builds a typed client
(`RpcClient.layerProtocolHttp`). Tests cover both `RpcTest` in-process and a real HTTP round trip.

## Schema-derived advertisement

`Capabilities.tools` comes from the live toolkit via `Tool.getJsonSchema` — the same JSON Schema
Effect AI sends to providers, so model and client see one schema with no second source of truth.
Models come from the catalog, skills from the `Skills` service, `defaultModelId` from the catalog's
first entry.

## Why RPC is a view, not the whole thing

The kernel services are ordinary Effect services; an Effect program can call `Agent.prompt` directly
and get the same stream. The RPC group adds a serialization boundary and a typed client, nothing
more. Capability discovery reads the toolkit, catalog, and skills the agent is already wired with —
there is no registry to keep in sync.

## Deliberate cuts

- No session queue: a second prompt on a busy session fails with `SessionBusy`.
- No transport demo beyond HTTP; WebSockets mount the same `RpcGroup`.
- No durable store in the kernel; storage is a layer the caller provides.
- Preliminary tool results are skipped; only the final `ToolResult` streams.
