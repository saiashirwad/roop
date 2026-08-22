# Roop

Roop is an agent loop written in Effect. An agent is a value. A tool is a value. So are
capabilities, middleware, and the journal that records what happened. You wire them with `Layer`,
run them as an `Effect` or a `Stream`, and stop them by interrupting the fiber.

Roop does not choose a model provider. It takes whatever `LanguageModel` you give it from
`effect/unstable/ai`. It does not own a database either. You hand it a `Journal` service and it
appends events to that.

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

`ModelLive` is any `Layer<LanguageModel>`. [`examples/deepseek.ts`](examples/deepseek.ts) has one.

## Why another agent library

Every agent framework I have read ends up rebuilding a runtime. A plugin registry. A cancellation
token passed through every function. A hook bus. An event emitter with its own subscription rules.
None of that is about agents. It is plumbing, and Effect already ships better plumbing than any of
them.

So Roop uses Effect's. A tool lists the services it needs in `dependencies` and a `Layer` supplies
them. Interrupting a run interrupts every tool, every child agent, and every finalizer under it,
because they are all fibers. Tool failures come back typed in the error channel of `Agent.run`.
Events are a `Stream`. The journal stores whole semantic events (a tool call, a finished message)
and never stores token deltas.

The kernel imports `effect` and `effect/unstable/ai` and nothing else. A test walks `src/` and fails
on any other import. The same suite runs under Node and under Cloudflare's workerd, which is how I
know the "portable" claim is true rather than hoped for.

## Tools

A tool is a native Effect AI `Tool` plus an Effect handler. Roop adds no schema layer of its own.

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

`Orders` is now in the agent's requirements. If you forget to provide it, the program does not
compile.

## Delegation

`Agent.delegate` turns a child agent into a tool. Roop derives the child's session id from the
parent session and the tool call id, so reruns land in the same place. It forwards interruption,
streams the child's text back as the tool result, and wraps the child's events in a `Subagent` event
so a trace shows the nesting.

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

Before this existed, the subagent example was forty lines of `Fiber`, `Clock`, and
`Stream.runCollect`. That was the clearest sign the kernel was missing a layer.

## Sessions and streaming

```ts
const chat = Agent.session(assistant, "user-1")
const program = Effect.gen(function* () {
  yield* chat.run("My name is Sarah.")
  return yield* chat.run("What is my name?")
})

// Text as it arrives
Agent.streamText(assistant, { sessionId: "user-1", prompt: "Hi" }).pipe(
  Stream.runForEach(Console.log),
)

// Raw events: TextDelta, ReasoningDelta, ToolCall, ToolResult, Subagent, Finish
Agent.events(assistant, { sessionId: "user-1", prompt: "Hi" })
```

| Function           | Returns               |
| ------------------ | --------------------- |
| `Agent.run`        | `Effect<AgentResult>` |
| `Agent.streamText` | `Stream<string>`      |
| `Agent.events`     | `Stream<AgentEvent>`  |

`Agent.session` does no I/O. It is the agent plus a session id, and `run` reloads history from the
journal each time.

## Capabilities and middleware

A capability is a named bundle of instructions and tools. `Agent.when` includes one only if an
Effect says so.

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

Middleware wraps four hooks, `model`, `tool`, `step`, and `turn`. Each hook takes `next` and returns
a replacement. Leftmost middleware runs outermost. Errors, scopes, and finalizers keep their types
through the wrap, which is the part other hook systems lose.

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

Middleware attaches at the runtime, the agent, or a single request, and applies in that order.
[`examples/extensions/`](examples/extensions) has approval, a doom-loop guard, model fallback, and
context pruning. Each one imports only the public API. If an extension needs an internal import,
that is a bug in the public API, and I would rather fix the API than widen the import.

## Testing

`@roop/agent/testing` exports `scripted`, a fake `LanguageModel` that replays the stream parts you
give it. Tests need no API key and no network.

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
| [`packages/agent`](packages/agent)         | The kernel. Publishable, depends only on `effect`.                             |
| [`packages/agent-rpc`](packages/agent-rpc) | Example host. Serves an agent over Effect RPC with run supervision and replay. |

## Development

Node 24, pnpm 11, Effect `4.0.0-beta.97`. Effect 4 is a beta and the pin is exact on purpose.

```sh
pnpm install   # also clones the Effect source into .repos/effect
pnpm check     # typecheck, test (Node + workerd), pack smoke test, lint, format
```

## Further reading

- [Composition](docs/composition.md), [middleware](docs/middleware.md),
  [persistence](docs/persistence.md), [extensions](docs/extensions.md)
- [What Roop does not own](docs/what-roop-does-not-own.md)
- [Architecture decisions](docs/architecture/README.md)
- [Examples](examples/README.md)
