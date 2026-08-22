# Roop

Roop is an Effect-native agent framework where agents, capabilities, tools, and extensions compose
as explicit Effect values, typed services, streams, and layers.

```ts
import { Agent, Journal, Roop } from "@roop/agent"
import { Context, Effect, Layer, Schema } from "effect"
import { type LanguageModel, Tool } from "effect/unstable/ai"

class Orders extends Context.Service<
  Orders,
  { readonly lookup: (id: string) => Effect.Effect<string> }
>()("example/Orders") {}

const OrdersLive = Layer.succeed(Orders, {
  lookup: (id) => Effect.succeed(`order:${id}`),
})

declare const ModelLive: Layer.Layer<LanguageModel.LanguageModel>

const lookupTool = Tool.make("lookup_order", {
  parameters: Schema.Struct({ id: Schema.String }),
  success: Schema.String,
  dependencies: [Orders],
})

const lookup = Agent.tool(lookupTool, ({ id }) =>
  Effect.gen(function* () {
    const orders = yield* Orders
    return yield* orders.lookup(id)
  }),
)

const agent = Agent.make({
  name: "support",
  instructions: "Help with orders.",
  tools: [lookup],
})

const Live = Layer.mergeAll(
  Roop.layer({
    model: ModelLive,
    journal: Journal.memory,
  }),
  OrdersLive,
)

export const result = Agent.run(agent, {
  sessionId: "support-42",
  prompt: "Where is order 42?",
}).pipe(Effect.provide(Live))
```

`ModelLive` supplies an `effect/unstable/ai` `LanguageModel`. Roop does not select a provider.

Read [composition](docs/composition.md), [middleware](docs/middleware.md),
[persistence](docs/persistence.md), and [extension authoring](docs/extensions.md).
