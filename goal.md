# The missing architecture layer

Roop should have three conceptual levels:

```text
┌──────────────────────────────────────────────┐
│ Roop authoring framework                    │
│ Agent.make, Agent.tool, Agent.delegate,      │
│ Agent.run, Agent.session, Agent.capability   │
├──────────────────────────────────────────────┤
│ Roop kernel                                 │
│ Module, ToolRegistry, Middleware, Journal,   │
│ dynamic rendering, event interpreter        │
├──────────────────────────────────────────────┤
│ Effect AI                                   │
│ Tool, Toolkit, Prompt, LanguageModel         │
└──────────────────────────────────────────────┘
```

Your current code is mostly the middle layer.

That middle layer is valuable. `AgentDefinition` is a clean explicit value, `Module` preserves typed
`R` and `E`, and the tool registry rejects ambiguous composition.

But `Module` should be treated as **Roop’s internal composition IR**, not the thing every
application author writes directly.

# What the golden-path API should hide

The current subagent example is the clearest diagnostic. The application has to:

1. Define a native tool.
2. Bind it through `Module.tool`.
3. invent a child session ID using `Clock`;
4. call `Runtime.runAgent`;
5. fork it into a fiber;
6. bracket and interrupt the fiber;
7. collect all child events;
8. manually extract `TextDelta`;
9. join the output;
10. provide `JournalMemory`, `AgentRuntimeLive`, and the model layer.

None of those are the domain intent.

The domain intent is:

> “This lead agent may delegate research to that researcher agent.”

Roop’s authoring API should express exactly that.

# Target authoring API

I would make the common API look like this:

```ts
import { Agent, Journal, Roop } from "@roop/agent"
import { Console, Effect, Schema } from "effect"

import { DeepSeek } from "./deepseek.ts"

const researcher = Agent.make({
  name: "researcher",
  instructions:
    "You are a specialized technical researcher. " +
    "Return a two-sentence executive summary with key technical facts.",
})

const leadArchitect = Agent.make({
  name: "lead-architect",

  instructions:
    "You are a Lead Solutions Architect. " +
    "Delegate complex research to your researcher and synthesize the findings.",

  tools: [
    Agent.delegate(researcher, {
      name: "delegate_research",
      description: "Delegate in-depth technical research to a specialist researcher.",
      parameters: Schema.Struct({
        topic: Schema.String,
      }),
      prompt: ({ topic }) => `Research topic: ${topic}`,
    }),
  ],
})

const RoopLive = Roop.layer({
  model: DeepSeek.Live,
  journal: Journal.memory,
})

const program = Effect.gen(function* () {
  const reply = yield* Agent.run(leadArchitect, {
    sessionId: "lead-session-77",
    prompt: "Compare Effect fibers with traditional JavaScript Promises.",
  })

  yield* Console.log(reply.text)
}).pipe(Effect.provide(RoopLive))

Effect.runPromise(program)
```

This still uses:

- Effect values
- Effect errors and requirements
- Effect Schema
- Effect Layers
- Effect AI’s `LanguageModel`
- Effect AI’s tool machinery internally
- structured interruption

It hides only accidental orchestration.

# The public concepts Roop needs

## 1. `Agent.make({ ... })`

Keep the current low-level overload for advanced users, but add an object-based authoring overload:

```ts
const assistant = Agent.make({
  name: "assistant",
  instructions: "You are a helpful assistant.",
  tools: [lookupOrder, cancelOrder],
  capabilities: [customerContext],
  middleware: [approval],
  policy: {
    maxTurns: 10,
  },
})
```

Internally, this compiles to:

```ts
Agent.make(
  options.name,
  Module.all(
    Module.instructions(options.instructions),
    ...options.tools.map(toModule),
    ...options.capabilities.map(toModule),
  ),
)
```

The object API is the source-level framework. `Module` remains the internal algebra.

For advanced dynamic rendering, retain something explicit:

```ts
Agent.dynamic("support", (context) =>
  Effect.gen(function* () {
    // Return a native AgentPlan or Capability.
  }),
)
```

Do not force every simple agent through the dynamic-rendering form.

## 2. `Agent.tool`

Keep native Effect AI tool definitions. Roop should not recreate Effect AI’s schema and validation
API.

```ts
import { Tool } from "effect/unstable/ai"

const lookupDefinition = Tool.make("lookup_order", {
  description: "Look up an order.",
  parameters: Schema.Struct({
    id: Schema.String,
  }),
  success: Order,
})

const lookupOrder = Agent.tool(lookupDefinition, ({ id }) =>
  Effect.gen(function* () {
    const orders = yield* Orders
    return yield* orders.lookup(id)
  }),
)
```

Then:

```ts
const support = Agent.make({
  name: "support",
  instructions: "Help customers with orders.",
  tools: [lookupOrder],
})
```

This removes the awkward public pairing:

```ts
Module.tool(toolDefinition, handler)
```

without replacing Effect AI’s `Tool.make`.

Conceptually:

```ts
interface AgentTool<R, E> {
  readonly module: Module<R, E>
  readonly metadata: ToolMetadata
}
```

`Agent.tool` is thin sugar around `Module.tool`.

## 3. `Agent.delegate`

This is the most important missing abstraction.

```ts
const delegateResearch = Agent.delegate(researcher, {
  name: "delegate_research",
  description: "Research a technical subject.",
  parameters: Schema.Struct({
    topic: Schema.String,
  }),
  prompt: ({ topic }) => `Research topic: ${topic}`,
})
```

`Agent.delegate` should:

- construct the Effect AI tool;
- invoke the child through the Roop runtime service;
- create a deterministic child session;
- propagate interruption automatically;
- reduce the child response to text;
- map child failures into the declared tool failure;
- publish nested child events for tracing;
- retain parent/child linkage in the journal.

The default child session should not use wall-clock time. It should be derived from stable execution
identity:

```text
<parent-session>/agents/<child-name>/<tool-call-id>
```

To support this properly, add a small runtime-provided service:

```ts
export interface ToolExecutionContext {
  readonly sessionId: SessionId
  readonly runId: RunId
  readonly turn: number
  readonly step: number
  readonly callId: string
}
```

The kernel should provide this around every tool handler. Effect AI’s native handler context still
owns `preliminary`; Roop’s context adds orchestration identity.

That service will also help future extensions such as:

- durable tool steps
- idempotency keys
- audit annotations
- nested tracing
- child agent linkage
- per-call resource scopes

## 4. `Agent.run`

The most common API should not return an unprocessed event stream.

```ts
const result =
  yield *
  Agent.run(agent, {
    sessionId,
    prompt,
  })

result.text
result.reasoning
result.finishReason
result.toolCalls
result.toolResults
```

Directionally:

```ts
export interface AgentResult {
  readonly sessionId: SessionId
  readonly runId: RunId
  readonly text: string
  readonly reasoning: string
  readonly finishReason: "completed" | "failed" | "interrupted" | "stopped"
  readonly toolCalls: ReadonlyArray<ToolCallSummary>
  readonly toolResults: ReadonlyArray<ToolResultSummary>
}
```

The raw stream remains available through a separate function:

```ts
Agent.events(agent, request)
```

And the common streaming case should avoid event switching:

```ts
Agent.streamText(agent, request)
```

Usage:

```ts
yield *
  Agent.streamText(assistant, {
    sessionId: "session-1",
    prompt: "Explain Effect fibers.",
  }).pipe(Stream.runForEach((delta) => Console.log(delta)))
```

The current basic example requires a manual `switch`, `Stream.tap`, `Stream.runDrain`, and direct
journal/model provisioning merely to print text.

Expose all three levels deliberately:

```text
Agent.run         → Effect<AgentResult>
Agent.streamText  → Stream<string>
Agent.events      → Stream<AgentEvent>
```

## 5. `Agent.session`

Persistent conversations should have an address-like handle:

```ts
const conversation = Agent.session(leadArchitect, "lead-session-77")

const first = yield * conversation.run("Compare fibers with promises.")

const second = yield * conversation.run("Now focus only on cancellation semantics.")
```

Creating the handle should perform no I/O. It is just an agent plus stable session ID.

```ts
interface AgentSession<R, E> {
  readonly id: SessionId

  readonly run: (
    prompt: string,
    options?: RunOptions,
  ) => Effect.Effect<AgentResult, E | RuntimeError, R | Roop>

  readonly events: (
    prompt: string,
    options?: RunOptions,
  ) => Stream.Stream<AgentEvent, E | RuntimeError, R | Roop>

  readonly streamText: (
    prompt: string,
    options?: RunOptions,
  ) => Stream.Stream<string, E | RuntimeError, R | Roop>
}
```

This will make persistent conversation examples read like agent applications rather than journal
tests.

## 6. `Agent.capability`

You still need reusable composition units, but users should think in terms of capabilities rather
than the kernel’s `Module` representation.

```ts
const orderSupport = Agent.capability({
  name: "order-support",
  instructions: "Use order tools to resolve order questions.",
  tools: [lookupOrder, cancelOrder],
})

const shippingSupport = Agent.capability({
  name: "shipping-support",
  instructions: "Use shipping tools for delivery questions.",
  tools: [trackPackage],
})

const support = Agent.make({
  name: "support",
  instructions: "Help the customer.",
  capabilities: [orderSupport, shippingSupport],
})
```

A capability can simply wrap `Module` internally:

```ts
interface Capability<R, E> {
  readonly name: string
  readonly module: Module<R, E>
}
```

Dynamic composition:

```ts
const adminCapability = Agent.capability({
  name: "admin",
  instructions: "Administrative privileges are active.",
  tools: [restartServer],
})

const assistant = Agent.make({
  name: "assistant",
  capabilities: [
    standardCapability,
    Agent.when(CurrentUser.pipe(Effect.map((user) => user.isAdmin)), adminCapability),
  ],
})
```

This preserves the power currently demonstrated through `Module.when`, but the domain language
becomes “conditionally include this capability,” not “conditionally evaluate this plan fragment.”

# Runtime wiring should happen once

The current examples repeatedly provide some combination of:

```ts
JournalMemory.JournalMemory
Runtime.AgentRuntimeLive
DeepSeek.Live
domain service layers
```

Basic agents do not provide `AgentRuntimeLive`, while subagents must provide it because they
recursively obtain the runtime service. That asymmetry is a sign that the application runtime is not
closed at the right boundary.

Add a single application layer constructor:

```ts
const RoopLive = Roop.layer({
  model: DeepSeek.Live,
  journal: Journal.memory,
  middleware: [tracing],
})
```

Conceptually, it builds:

```ts
Layer.mergeAll(DeepSeek.Live, JournalMemory, AgentRuntimeLive, MiddlewareLive)
```

More importantly, the resulting `Roop` service should capture those infrastructure services, so
individual calls require only:

- the Roop runtime service;
- agent-specific domain services.

Application setup remains Effect-native:

```ts
const AppLive = Roop.layer({
  model: DeepSeek.Live,
  journal: Journal.memory,
}).pipe(Layer.provide(OrdersLive), Layer.provide(ShippingLive))
```

The Layer remains visible. It simply moves to the composition root where it belongs.

# Middleware should be attachable to agents

The raw middleware API is a good advanced API, but the human-approval example demonstrates why it is
not a good golden path: users must manufacture Effect AI’s internal handler-result envelope and cast
it with `as never`.

Support middleware at three levels:

```text
Runtime middleware   global infrastructure policy
Agent middleware     agent-owned behavior
Request middleware   one-run override
```

For example:

```ts
const bankingAgent = Agent.make({
  name: "banking",
  instructions: "Help with banking operations.",
  tools: [checkBalance, transferFunds],
}).pipe(
  Agent.withMiddleware(
    Approval.middleware({
      service: ApprovalService,
      appliesTo: (tool) => tool.risk === "destructive",
    }),
  ),
)
```

Ordering should be explicit:

```text
runtime → agent → request → interpreter
```

The raw `Middleware.make` remains available under the advanced API for custom policies.

# Recommended package surface

Do not delete the low-level API. Move it out of the default path.

## Root: framework authoring API

```ts
import { Agent, AgentEvent, AgentResult, Capability, Journal, Roop } from "@roop/agent"
```

Primary functions:

```text
Agent.make
Agent.dynamic
Agent.tool
Agent.delegate
Agent.capability
Agent.when
Agent.withMiddleware
Agent.withPolicy
Agent.run
Agent.events
Agent.streamText
Agent.session

Roop.layer

Journal.memory
```

## Advanced subpath

```ts
import {
  AgentPlan,
  History,
  Journal,
  Middleware,
  Module,
  Runtime,
  ToolRegistry,
} from "@roop/agent/advanced"
```

This is where today’s public API belongs.

## Testing subpath

Keep:

```ts
import { scripted } from "@roop/agent/testing"
```

The current root exports essentially every subsystem as a namespace. That makes the package feel
like a toolbox because it is one.

# Your subagent example after the authoring layer

A complete target version should be roughly this:

```ts
import { Agent, Journal, Roop } from "@roop/agent"
import { Console, Effect, Schema } from "effect"

import { DeepSeek } from "./deepseek.ts"

const researcher = Agent.make({
  name: "researcher",
  instructions:
    "You are a specialized technical researcher. " +
    "Return a two-sentence executive summary with key technical facts.",
})

const leadArchitect = Agent.make({
  name: "lead-architect",

  instructions:
    "You are a Lead Solutions Architect. " +
    "Delegate complex technical research to the researcher, " +
    "then synthesize a final recommendation.",

  tools: [
    Agent.delegate(researcher, {
      name: "delegate_research",
      description: "Delegate in-depth technical research to a specialist.",
      parameters: Schema.Struct({
        topic: Schema.String,
      }),
      prompt: ({ topic }) => `Research topic: ${topic}`,
    }),
  ],
})

const Live = Roop.layer({
  model: DeepSeek.Live,
  journal: Journal.memory,
})

const program = Effect.gen(function* () {
  const session = Agent.session(leadArchitect, "lead-session-77")

  const reply = yield* session.run(
    "I need an architectural comparison between " +
      "Effect fibers and traditional JavaScript Promises.",
  )

  yield* Console.log(reply.text)
}).pipe(Effect.provide(Live))

Effect.runPromise(program)
```

For a streaming CLI:

```ts
const program = Agent.streamText(leadArchitect, {
  sessionId: "lead-session-77",
  prompt: "Compare Effect fibers with JavaScript Promises.",
}).pipe(
  Stream.runForEach((delta) => Console.log(delta)),
  Effect.provide(Live),
)
```

There should be no:

```text
Module
Runtime.runAgent
Clock
Fiber
Effect.acquireUseRelease
Stream.runCollect
manual TextDelta reduction
JournalMemory.JournalMemory
Runtime.AgentRuntimeLive
```

in the normal delegation example.

# How this maps onto the current kernel

This facade can be built without changing the interpreter’s fundamental architecture.

| High-level API         | Existing implementation                                 |
| ---------------------- | ------------------------------------------------------- |
| `Agent.make({ ... })`  | compiles to `Agent.make(name, Module.all(...))`         |
| `Agent.tool`           | wraps `Module.tool`                                     |
| `Agent.capability`     | wraps `Module`                                          |
| `Agent.when`           | wraps `Module.when`                                     |
| `Agent.delegate`       | native Effect AI tool + `Module.tool` + runtime service |
| `Agent.events`         | wraps `Runtime.runAgent`                                |
| `Agent.run`            | folds the event stream into `AgentResult`               |
| `Agent.streamText`     | filters `TextDelta` events                              |
| `Agent.session`        | closes over agent and session ID                        |
| `Roop.layer`           | provides model, journal, middleware, and runtime        |
| `Agent.withMiddleware` | merges agent defaults into request middleware           |
| `Agent.withPolicy`     | merges agent policy with request policy                 |

That is the key constraint:

> **The authoring API must compile into the kernel; it must not create a second runtime or a second
> dependency-injection system.**

# Implementation sequence

## Phase 1: result and runtime ergonomics

Add:

```text
AgentResult.ts
AgentSession.ts
Roop.ts
```

Implement:

```text
Agent.events
Agent.streamText
Agent.run
Agent.session
Roop.layer
Journal.memory
```

Rewrite examples 01 and 03 first.

At the end of this phase, a basic agent should not mention `Runtime`, `JournalMemory`, or manual
event reduction.

## Phase 2: hide `Module`

Add the object overload:

```ts
Agent.make({
  name,
  instructions,
  tools,
  capabilities,
})
```

Add:

```text
Agent.tool
Agent.capability
Agent.when
Agent.dynamic
```

Keep the current `Agent.make(name, Module)` overload temporarily for advanced compatibility.

Rewrite tools and dynamic-capability examples.

## Phase 3: first-class agent composition

Add:

```text
ToolExecutionContext
Agent.delegate
Agent.asTool
```

Implement:

- deterministic child-session derivation;
- child interruption propagation;
- child response reduction;
- child failure mapping;
- nested tracing events;
- parent/child journal linkage.

Rewrite example 06. That example is the primary acceptance test for whether Roop composes agents
elegantly.

## Phase 4: agent-owned defaults

Extend the high-level `Agent` value with:

```text
middleware
policy
metadata
```

Add:

```text
Agent.withMiddleware
Agent.withPolicy
Agent.annotate
```

Runtime precedence:

```text
runtime defaults
  overridden by agent defaults
    overridden by request options
```

Rewrite examples 05 and 07.

## Phase 5: narrow the root API

Move these to `@roop/agent/advanced`:

```text
AgentPlan
History
Module
Raw Journal service
Raw Middleware
Kernel Runtime
ToolRegistry
```

Keep the root focused on authoring and running agents.

# Guardrails

Do **not** overcorrect by hiding Effect itself.

Keep visible:

- `Effect` in every handler
- `Context.Service` for dependencies
- `Layer` at the application boundary
- Effect `Schema`
- native Effect AI `Tool`
- native `LanguageModel` providers
- `Stream` for advanced observation

Hide:

- plan compilation
- toolkit installation
- journal implementation selection per invocation
- event folding
- child fiber choreography
- child-session generation
- internal tool-result envelopes
- runtime service installation
- parent/child trace plumbing

# Definition of done

The framework layer is successful when:

1. A basic agent is under roughly 15 meaningful lines.
2. An agent with two tools never mentions `Module`.
3. A subagent example never mentions `Runtime`, `Fiber`, `Clock`, or `Stream.runCollect`.
4. A normal invocation returns `AgentResult`, not a raw event stream.
5. Streaming text requires no event switch.
6. Runtime infrastructure is provided once at the application boundary.
7. Reusable capabilities preserve Effect `R` and `E`.
8. Native Effect AI tools remain usable directly.
9. The advanced kernel remains fully accessible.
10. No public golden-path example contains `as never`.

The present repository is not a failed framework. It is a good kernel that is missing its most
important product layer. The next milestone should therefore be named something like **“Roop
Authoring API”**, not another kernel refactor.
