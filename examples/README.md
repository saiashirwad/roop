# Roop Examples: Effect-First Alternative to Flue

[Flue](https://flueframework.com/) uses React-style hooks (`useTool`, `usePersistentState`,
`useAgentStart`) and global harness state.

**Roop** is an Effect-native agent framework where agents, modules, tools, and extensions compose as
explicit Effect values, typed services, streams, and layers.

---

## Architectural Comparison: Flue vs. Roop

| Feature                      | Flue Framework                                                                 | Roop (Effect-Native)                                                                                          |
| :--------------------------- | :----------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------ |
| **Agent Definition**         | React-style function with side-effect hooks (`useModel`, `usePersistentState`) | Declarative, pure Effect values: `Agent.make(name, Module.all(...))`                                          |
| **Tool Calling**             | `useTool({ run: ({ harness }) => ... })` (reads global state)                  | Typed `Tool.make` with `Schema.Struct`, declaring explicit `Context.Service` dependencies                     |
| **Service Injection**        | Hardcoded client instances or global singletons                                | Effect 3-Role Discipline: `Definition` (`Context.Service`), `Consumer` (`dependencies`), `Provider` (`Layer`) |
| **Conversation State**       | `usePersistentState('key', default)`                                           | Append-only semantic event journal (`Journal` / `JournalMemory`) with automatic turn recovery                 |
| **Concurrency & Interrupts** | Custom abort handles                                                           | First-class structured concurrency with Effect `Fibers`, `Effect.acquireUseRelease`, `Effect.ensuring`        |
| **Resilience & Middleware**  | Ad-hoc lifecycle callbacks                                                     | Composable `Middleware.make` wrapping model, tool, step, and turn execution streams                           |
| **Subagents**                | Separate deployed agents or complex server routing                             | Ordinary typed tools calling `Runtime.runAgent` with isolated child sessions                                  |
| **Provider Portability**     | Tied to provider-specific wrappers                                             | Portable `effect/unstable/ai` `LanguageModel` layer swap                                                      |

---

## Available Examples

### 1. [01 - Basic Assistant Agent](./01-basic-agent.ts)

A minimal, pure assistant that accepts user prompts and streams response deltas.

```bash
DEEPSEEK_API_KEY="your-api-key" npx tsx examples/01-basic-agent.ts
```

### 2. [02 - Tools and Services with Dependency Injection](./02-tools-and-services.ts)

Demonstrates typed tools with schema validation and Effect service injection (`InventoryService`,
`ShippingService`).

```bash
DEEPSEEK_API_KEY="your-api-key" npx tsx examples/02-tools-and-services.ts
```

### 3. [03 - Persistent Conversations & Durable State](./03-persistent-conversations.ts)

Demonstrates multi-turn conversation persistence across prompts using durable `Journal` events
without manual message history stitching.

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

Intercepts protected actions (e.g. fund transfers) using `ApprovalService` middleware, rejecting
unapproved executions before handlers run.

```bash
DEEPSEEK_API_KEY="your-api-key" npx tsx examples/05-human-in-the-loop.ts
```

### 6. [06 - Subagent Orchestration & Delegation](./06-subagent-delegation.ts)

A lead coordinator agent delegates specialized research tasks to a child agent running in an
isolated sub-session with structured cancellation.

```bash
DEEPSEEK_API_KEY="your-api-key" npx tsx examples/06-subagent-delegation.ts
```

### 7. [07 - Resilience & Doom Loop Protection](./07-resilient-agent.ts)

Protects against infinite repeating tool calls with a `doomLoop` middleware and supports model
fallbacks on failure.

```bash
DEEPSEEK_API_KEY="your-api-key" npx tsx examples/07-resilient-agent.ts
```

### 8. [08 - Dynamic Modules & Contextual Capabilities](./08-dynamic-modules.ts)

Conditionally attaches tools and instructions at runtime using `Module.when` based on user
permissions or session role.

```bash
DEEPSEEK_API_KEY="your-api-key" npx tsx examples/08-dynamic-modules.ts
```

---

## DeepSeek Provider Integration

The [`examples/deepseek.ts`](./deepseek.ts) module provides an `effect/unstable/ai` `LanguageModel`
layer configured for DeepSeek:

```ts
import { Agent, JournalMemory, Module, Runtime } from "@roop/agent"
import { Effect, Layer, Stream } from "effect"
import { DeepSeek } from "./deepseek.ts"

const agent = Agent.make("assistant", Module.instructions("You are a helpful assistant."))

const events = Runtime.runAgent(agent, {
  sessionId: "session-1",
  prompt: "Hello DeepSeek!",
}).pipe(
  Stream.provide(
    Layer.mergeAll(
      JournalMemory.JournalMemory,
      DeepSeek.Live, // Reads DEEPSEEK_API_KEY from environment
    ),
  ),
)
```

Supported pre-configured layers:

- `DeepSeek.Live`: Default chat model (`deepseek-chat` / DeepSeek-V3).
- `DeepSeek.reasonerLive`: Reasoning model (`deepseek-reasoner` / DeepSeek-R1) with `ReasoningDelta`
  streaming.
- `DeepSeek.layer({ apiKey, model, apiUrl })`: Custom configuration.
