# Roop Examples: Effect-First Agent Framework

[Flue](https://flueframework.com/) uses React-style hooks (`useTool`, `usePersistentState`,
`useAgentStart`) and global harness state.

**Roop** is an Effect-native agent framework where agents, capabilities, tools, and extensions
compose as explicit Effect values, typed services, streams, and layers.

---

## Architectural Comparison: Flue vs. Roop

| Feature                      | Flue Framework                                                                 | Roop (Effect-Native)                                                                                          |
| :--------------------------- | :----------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------ |
| **Agent Definition**         | React-style function with side-effect hooks (`useModel`, `usePersistentState`) | Declarative, pure Effect values: `Agent.make({ name, instructions, tools, capabilities })`                    |
| **Tool Calling**             | `useTool({ run: ({ harness }) => ... })` (reads global state)                  | Typed `Tool.make` bound via `Agent.tool`, declaring explicit `Context.Service` dependencies                   |
| **Subagents & Delegation**   | Separate deployed agents or complex server routing                             | First-class delegation via `Agent.delegate(child, { ... })` with deterministic child sessions                 |
| **Execution Ergonomics**     | Ad-hoc lifecycle callbacks                                                     | Returns structured `AgentResult` via `Agent.run` or streaming via `Agent.streamText` and `Agent.events`       |
| **Conversation State**       | `usePersistentState('key', default)`                                           | Append-only semantic event journal (`Journal.memory`) addressed via `Agent.session(agent, id)`                |
| **Service Injection**        | Hardcoded client instances or global singletons                                | Effect 3-Role Discipline: `Definition` (`Context.Service`), `Consumer` (`dependencies`), `Provider` (`Layer`) |
| **Infrastructure Wiring**    | Global harness or manual client configuration                                  | Composed once at the boundary via `Roop.layer({ model, journal, middleware })`                                |
| **Concurrency & Interrupts** | Custom abort handles                                                           | Structured concurrency with Effect Fibers and interruption propagation                                        |
| **Provider Portability**     | Tied to provider-specific wrappers                                             | Portable `effect/unstable/ai` `LanguageModel` layer swap                                                      |

---

## Available Examples

### 1. [01 - Basic Assistant Agent](./01-basic-agent.ts)

A minimal, pure assistant that returns an `AgentResult` with answer text.

```bash
DEEPSEEK_API_KEY="your-api-key" npx tsx examples/01-basic-agent.ts
```

### 2. [02 - Tools and Services with Dependency Injection](./02-tools-and-services.ts)

Demonstrates typed tools with schema validation and Effect service injection (`InventoryService`,
`ShippingService`) using `Agent.tool`.

```bash
DEEPSEEK_API_KEY="your-api-key" npx tsx examples/02-tools-and-services.ts
```

### 3. [03 - Persistent Conversations & Durable State](./03-persistent-conversations.ts)

Demonstrates multi-turn conversation persistence across prompts using `Agent.session` and durable
`Journal` events.

```bash
DEEPSEEK_API_KEY="your-api-key" npx tsx examples/03-persistent-conversations.ts
```

### 4. [04 - DeepSeek Reasoner (R1 Thinking Stream)](./04-reasoning-agent.ts)

Streams both real-time chain-of-thought tokens (`ReasoningDelta`) and final answer tokens
(`TextDelta`) using DeepSeek-R1 (`deepseek-reasoner`).

```bash
DEEPSEEK_API_KEY="your-api-key" npx tsx examples/04-reasoning-agent.ts
```

### 5. [05 - Human-in-the-Loop & Tool Approvals](./05-human-in-the-loop.ts)

Intercepts protected actions (e.g. fund transfers) using `ApprovalService` middleware and
`Middleware.denyTool`, rejecting unapproved executions before handlers run.

```bash
DEEPSEEK_API_KEY="your-api-key" npx tsx examples/05-human-in-the-loop.ts
```

### 6. [06 - Subagent Orchestration & Delegation](./06-subagent-delegation.ts)

A lead coordinator agent delegates specialized research tasks to a child agent using
`Agent.delegate` with deterministic child session tracking and structured interruption.

```bash
DEEPSEEK_API_KEY="your-api-key" npx tsx examples/06-subagent-delegation.ts
```

### 7. [07 - Resilience & Doom Loop Protection](./07-resilient-agent.ts)

Protects against infinite repeating tool calls with a `doomLoop` middleware and
`Middleware.denyTool`.

```bash
DEEPSEEK_API_KEY="your-api-key" npx tsx examples/07-resilient-agent.ts
```

### 8. [08 - Dynamic Capabilities & Contextual Modules](./08-dynamic-modules.ts)

Conditionally attaches tools and instructions at runtime using `Agent.capability` and `Agent.when`
based on user permissions.

```bash
DEEPSEEK_API_KEY="your-api-key" npx tsx examples/08-dynamic-modules.ts
```

---

## DeepSeek Provider Integration

The [`examples/deepseek.ts`](./deepseek.ts) module provides an `effect/unstable/ai` `LanguageModel`
layer configured for DeepSeek:

```ts
import { Agent, Journal, Roop } from "@roop/agent"
import { Console, Effect } from "effect"
import { DeepSeek } from "./deepseek.ts"

const assistant = Agent.make({
  name: "assistant",
  instructions: "You are a helpful assistant.",
})

const Live = Roop.layer({
  model: DeepSeek.Live,
  journal: Journal.memory,
})

const program = Effect.gen(function* () {
  const reply = yield* Agent.run(assistant, {
    sessionId: "session-1",
    prompt: "Hello DeepSeek!",
  })
  yield* Console.log(reply.text)
}).pipe(Effect.provide(Live))
```

Supported pre-configured layers:

- `DeepSeek.Live`: Default chat model (`deepseek-chat` / DeepSeek-V3).
- `DeepSeek.reasonerLive`: Reasoning model (`deepseek-reasoner` / DeepSeek-R1) with `ReasoningDelta`
  streaming.
- `DeepSeek.layer({ apiKey, model, apiUrl })`: Custom configuration.
