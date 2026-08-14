# Roop

A smol, Effect-native agents layer. One kernel, one protocol, one Node adapter.

## Packages

- `packages/agent` — the kernel. Plain Effect services over `effect/unstable/ai`; imports nothing
  platform-specific (`test/portability.test.ts` guards imports) and the core suite runs inside real
  workerd (`test-workerd/`).
- `packages/agent-rpc` — the protocol. One `RpcGroup` over the kernel, plus HTTP transport helpers.
- `packages/agent-node` — the Node adapter: a readline CLI over the kernel.
- `packages/plugin-openai` / `plugin-claude` / `plugin-codex` — model plugins: any OpenAI-compatible
  API, the local `claude` CLI, and the local `codex` CLI.
- `packages/plugin-skills` — `SkillsDir(dir)` scans `*/SKILL.md`, advertises the skills, and serves
  their content through a `skill` tool plus a system prompt fragment.
- `packages/plugin-web` / `plugin-todo` — tool plugins: `webFetch` over `HttpClient` and a
  `writeTodos` planning tool.
- `packages/coding-tools` — a toolkit as a library. Four coding tools (`readFile`, `writeFile`,
  `listFiles`, `bash`) that declare their service `dependencies` (`FileSystem`,
  `ChildProcessSpawner`); nothing agent-specific, composed in at harness build time.
- `packages/coding-harness` — the composition. Kernel + coding tools + DeepSeek mounted behind the
  RPC group on a Node HTTP server.
- `packages/coding-web` — the web client. React + StyleX + `@effect/atom-react` atoms over the same
  RPC client; streaming transcript, tool cards, model picker, skills and tools panels.
- `packages/coding-tui` — the client. A pi-like terminal UI (`@mariozechner/pi-tui`) that talks to
  the harness exclusively through the typed RPC client; a test rejects any other import.

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

## Plugins

A `Plugin` is a value: a name plus optional contributions — a toolkit with its handlers layer, model
specs, skills, and a system prompt fragment. `AgentPlugins(plugins)` merges the toolkits, provides
the handler layers, builds one model catalog, concatenates prompts, and returns an `Agent` layer
that still asks the host for a `SessionStore` and the handlers' platform services. Anything an agent
is made of arrives as a plugin; a custom plugin is just another record.

`subagent({ name, description, plugins, ... })` is a plugin built from plugins: it composes a child
agent (with its own ephemeral in-memory sessions), wraps it in the delegation tool from
`agentTool.ts`, and hands the parent a single tool that takes a task and returns a summary.
Delegation depth is unbounded because a subagent's plugins may themselves contain subagents.

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
