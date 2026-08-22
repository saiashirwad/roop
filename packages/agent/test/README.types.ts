import { Context, Effect, Layer, Schema } from "effect"
import { type LanguageModel, Tool } from "effect/unstable/ai"

import { Agent, Journal, Roop } from "../src/index.ts"

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

export const readmeExample = Agent.run(agent, {
  sessionId: "support-42",
  prompt: "Where is order 42?",
}).pipe(Effect.provide(Live))
