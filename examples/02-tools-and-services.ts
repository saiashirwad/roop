import { Agent, Journal, Roop } from "@roop/agent"
import { Console, Context, Effect, Layer, Schema } from "effect"
import { Tool } from "effect/unstable/ai"

import { DeepSeek } from "./deepseek.ts"

export class InventoryService extends Context.Service<
  InventoryService,
  {
    readonly getStock: (
      sku: string,
    ) => Effect.Effect<{ readonly inStock: boolean; readonly quantity: number }>
  }
>()("example/InventoryService") {}

export class ShippingService extends Context.Service<
  ShippingService,
  {
    readonly getTrackingStatus: (
      trackingNumber: string,
    ) => Effect.Effect<{ readonly status: string; readonly etaDays: number }>
  }
>()("example/ShippingService") {}

const InventoryLive = Layer.succeed(InventoryService, {
  getStock: (sku) =>
    Effect.succeed(
      sku.toLowerCase().includes("keyboard")
        ? { inStock: true, quantity: 15 }
        : { inStock: false, quantity: 0 },
    ),
})

const ShippingLive = Layer.succeed(ShippingService, {
  getTrackingStatus: (_trackingNumber) =>
    Effect.succeed({ status: "Out for delivery", etaDays: 1 }),
})

const checkInventoryDefinition = Tool.make("check_inventory", {
  description: "Check product inventory availability and remaining stock quantity by SKU",
  parameters: Schema.Struct({ sku: Schema.String }),
  success: Schema.Struct({ inStock: Schema.Boolean, quantity: Schema.Finite }),
  dependencies: [InventoryService],
})

const trackPackageDefinition = Tool.make("track_package", {
  description: "Track package status and estimated delivery time by tracking number",
  parameters: Schema.Struct({ trackingNumber: Schema.String }),
  success: Schema.Struct({ status: Schema.String, etaDays: Schema.Finite }),
  dependencies: [ShippingService],
})

const checkInventory = Agent.tool(checkInventoryDefinition, ({ sku }) =>
  Effect.gen(function* () {
    const inventory = yield* InventoryService
    return yield* inventory.getStock(sku)
  }),
)

const trackPackage = Agent.tool(trackPackageDefinition, ({ trackingNumber }) =>
  Effect.gen(function* () {
    const shipping = yield* ShippingService
    return yield* shipping.getTrackingStatus(trackingNumber)
  }),
)

const supportAgent = Agent.make({
  name: "support-agent",
  instructions:
    "You are a customer support agent for an electronics store. Use the available tools to answer customer questions.",
  tools: [checkInventory, trackPackage],
})

const AppLive = Layer.mergeAll(
  Roop.layer({
    model: DeepSeek.Live,
    journal: Journal.memory,
  }),
  InventoryLive,
  ShippingLive,
)

const program = Effect.gen(function* () {
  const reply = yield* Agent.run(supportAgent, {
    sessionId: "support-session-42",
    prompt: "Do you have the 'wireless-keyboard-v2' in stock, and where is package TRK-9900?",
  })

  yield* Console.log(reply.text)
}).pipe(Effect.provide(AppLive))

if (process.argv[1]?.endsWith("02-tools-and-services.ts")) {
  Effect.runPromise(program).catch(console.error)
}
