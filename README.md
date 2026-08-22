# Roop

An Effect-native agent kernel. Agents, tools, capabilities, middleware, and journals are plain
Effect values. You wire them with `Layer`, run them as `Effect` or `Stream`, and cancel them with
interruption.

Roop does not pick a model provider, a database, or a transport. It takes a `LanguageModel` from
`effect/unstable/ai` and a `Journal` service, and runs the loop.

```ts
import { Agent, Journal, Roop } from "@roop/agent"
import { Console, Effect } from "effect"

const assistant = Agent.make({
  name: "assistant",
  instructions: "Answer clearly in one or two sentences.",
})

const Live = Roop.layer({ model: ModelLive, journal: Journal.memory })

const program = Effect.gen(function* () {
  const reply = yield* Agent.run(assistant, {
    sessionId: "user-1",
    prompt: "Why is the sky blue?",
  })
  yield* Console.log(reply.text)
}).pipe(Effect.provide(Live))
```

`ModelLive` is any `Layer<LanguageModel>`. See [`examples/deepseek.ts`](examples/deepseek.ts) for
one.

## Why

Most agent frameworks invent their own runtime: a plugin registry, a cancellation token, a hook bus,
an event emitter. Effect already has all of these. Roop uses them instead.

- **Dependencies** are `Context.Service` tags. A tool declares what it needs; a `Layer` provides it.
- **Cancellation** is fiber interruption. Interrupt the stream and every tool, child agent, and
  finalizer stops with it.
- **Errors** are typed. `Agent.run` carries your tool failures in its error channel.
- **Observation** is a `Stream` of events.
- **Persistence** is an append-only, versioned journal of semantic events. Token deltas are never
  stored.

The kernel imports only `effect` and `effect/unstable/ai`. A test enforces it, and the suite runs in
both Node and Cloudflare's workerd.

## Tools

Tools are native Effect AI `Tool` definitions plus an Effect handler.

```ts
import { Agent } from "@roop/agent"
import { Context, Effect, Layer, Schema } from "effect"
import { Tool } from "effect/unstable/ai"

class Orders extends Context.Service<
  Orders,
  { readonly lookup: (id: string) => Effect.Effect<string> }
>()("app/Orders") {}

const lookup = Agent.tool(
  Tool.make("lookup_order", {
    parameters: Schema.Struct({ id: Schema.String }),
    success: Schema.String,
    dependencies: [Orders],
  }),
  ({ id }) => Effect.flatMap(Orders, (orders) => orders.lookup(id)),
)

const support = Agent.make({
  name: "support",
  instructions: "Help with orders.",
  tools: [lookup],
})
```

`Orders` shows up in the agent's requirements. Provide it next to `Roop.layer` and the types check.

## Delegation

A child agent becomes a tool with `Agent.delegate`. Roop derives a stable child session, forwards
interruption, streams the child's text back as the tool result, and nests the child's events for
tracing.

```ts
const researcher = Agent.make({
  name: "researcher",
  instructions: "Return a two-sentence technical summary.",
})

const lead = Agent.make({
  name: "lead",
  instructions: "Delegate research, then recommend.",
  tools: [
    Agent.delegate(researcher, {
      name: "delegate_research",
      parameters: Schema.Struct({ topic: Schema.String }),
      prompt: ({ topic }) => `Research: ${topic}`,
    }),
  ],
})
```

## Sessions and streaming

```ts
const chat = Agent.session(assistant, "user-1")
const program = Effect.gen(function* () {
  yield* chat.run("My name is Sarah.")
  return yield* chat.run("What is my name?")
})

// Stream text instead of waiting for the result
Agent.streamText(assistant, { sessionId: "user-1", prompt: "Hi" }).pipe(
  Stream.runForEach(Console.log),
)

// Or take the raw events: TextDelta, ReasoningDelta, ToolCall, ToolResult, Subagent, Finish
Agent.events(assistant, { sessionId: "user-1", prompt: "Hi" })
```

Three levels, chosen on purpose:

| Function           | Returns               |
| ------------------ | --------------------- |
| `Agent.run`        | `Effect<AgentResult>` |
| `Agent.streamText` | `Stream<string>`      |
| `Agent.events`     | `Stream<AgentEvent>`  |

## Capabilities and middleware

Group instructions and tools into reusable units, and include them conditionally.

```ts
const admin = Agent.capability({
  name: "admin",
  instructions: "Administrative privileges are active.",
  tools: [restartServer],
})

const assistant = Agent.make({
  name: "assistant",
  capabilities: [standard, Agent.when(isAdmin, admin)],
})
```

Middleware wraps the `model`, `tool`, `step`, and `turn` hooks. It composes like a typed `around`:
leftmost is outermost, and failures, scopes, and finalizers keep their types.

```ts
const approval = Middleware.make({
  tool: (next) => (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const approve = yield* ApprovalService
        const ok = yield* approve({ tool: input.name, params: input.params })
        return ok ? next(input) : Middleware.denyTool("approval denied")
      }),
    ),
})

const banking = Agent.make({ name: "banking", tools: [transfer] }).pipe(
  Agent.withMiddleware(approval),
)
```

Middleware attaches at three levels, applied runtime → agent → request. See
[`examples/extensions/`](examples/extensions) for approval, doom-loop guards, model fallback, and
context pruning, each written against the public API alone.

## Testing

`@roop/agent/testing` ships `scripted`, a fake `LanguageModel` that replays stream parts. No keys
needed.

```ts
import { scripted } from "@roop/agent/testing"

const Live = Layer.unwrap(
  Effect.map(scripted([[{ type: "text-delta", id: "t", delta: "hello" }]]), (model) =>
    Roop.layer({ model, journal: Journal.memory }),
  ),
)
```

## Packages

| Package                                    | Role                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------ |
| [`packages/agent`](packages/agent)         | The kernel. Portable, publishable, depends only on `effect`.                   |
| [`packages/agent-rpc`](packages/agent-rpc) | Example host: serves an agent over Effect RPC with run supervision and replay. |

## Development

Requires Node 24, pnpm 11, and Effect `4.0.0-beta.97`.

```sh
pnpm install   # also vendors the Effect source into .repos/effect
pnpm check     # typecheck, test (Node + workerd), pack smoke test, lint, format
```

## Read more

- [Composition](docs/composition.md), [middleware](docs/middleware.md),
  [persistence](docs/persistence.md), [extensions](docs/extensions.md)
- [What Roop does not own](docs/what-roop-does-not-own.md)
- [Architecture decisions](docs/architecture/README.md)
- [Examples](examples/README.md)
