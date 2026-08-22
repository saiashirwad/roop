# Roop

Roop is an Effect-native agent runtime where agents and extensions compose as explicit effects,
modules, middleware, services, and layers.

```ts
import { Agent, JournalMemory, Module, Runtime } from "@roop/agent"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { type LanguageModel, Tool } from "effect/unstable/ai"

class Orders extends Context.Service<
  Orders,
  { readonly lookup: (id: string) => Effect.Effect<string> }
>()("example/Orders") {}

const OrdersLive = Layer.succeed(Orders, {
  lookup: (id) => Effect.succeed(`order:${id}`),
})

declare const ModelLive: Layer.Layer<LanguageModel.LanguageModel>

const lookup = Tool.make("lookup_order", {
  parameters: Schema.Struct({ id: Schema.String }),
  success: Schema.String,
  dependencies: [Orders],
})

const agent = Agent.make(
  "support",
  Module.all(
    Module.instructions("Help with orders."),
    Module.tool(lookup, ({ id }) =>
      Effect.gen(function* () {
        return yield* (yield* Orders).lookup(id)
      }),
    ),
  ),
)

const events = Runtime.runAgent(agent, {
  sessionId: "support-42",
  prompt: "Where is order 42?",
}).pipe(Stream.provide(Layer.mergeAll(JournalMemory.JournalMemory, OrdersLive, ModelLive)))
```

`ModelLive` supplies an `effect/unstable/ai` `LanguageModel`. Roop does not select a provider.

Read [composition](docs/composition.md), [middleware](docs/middleware.md),
[persistence](docs/persistence.md), and [extension authoring](docs/extensions.md).
