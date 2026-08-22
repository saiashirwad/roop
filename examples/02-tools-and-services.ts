import { Agent, JournalMemory, Module, Runtime } from "@roop/agent"
import { Console, Context, Effect, Layer, Schema, Stream } from "effect"
import { Tool } from "effect/unstable/ai"

import { DeepSeek } from "./deepseek.ts"

/**
 * 02 - Tools and Services with Dependency Injection
 *
 * Demonstrates how Roop models tools with typed Schemas and Effect Context Services.
 * Contrast with Flue: In Flue, tools access global harness state. In Roop, tools
 * declare explicit service dependencies and compose cleanly via Layers.
 */

// 1. Define Domain Services (Definition)
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

// 2. Implement Service Providers (Provider)
const InventoryLive = Layer.succeed(InventoryService, {
  getStock: (sku) =>
    Effect.gen(function* () {
      yield* Console.log(`[InventoryService] Checking stock for SKU: ${sku}`)
      if (sku.toLowerCase().includes("keyboard")) {
        return { inStock: true, quantity: 15 }
      }
      return { inStock: false, quantity: 0 }
    }),
})

const ShippingLive = Layer.succeed(ShippingService, {
  getTrackingStatus: (trackingNumber) =>
    Effect.gen(function* () {
      yield* Console.log(`[ShippingService] Tracking shipment: ${trackingNumber}`)
      return { status: "Out for delivery", etaDays: 1 }
    }),
})

// 3. Define Tools declaring Service Dependencies (Consumer)
const checkInventoryTool = Tool.make("check_inventory", {
  description: "Check product inventory availability and remaining stock quantity by SKU",
  parameters: Schema.Struct({ sku: Schema.String }),
  success: Schema.Struct({ inStock: Schema.Boolean, quantity: Schema.Finite }),
  dependencies: [InventoryService],
})

const trackPackageTool = Tool.make("track_package", {
  description: "Track package status and estimated delivery time by tracking number",
  parameters: Schema.Struct({ trackingNumber: Schema.String }),
  success: Schema.Struct({ status: Schema.String, etaDays: Schema.Finite }),
  dependencies: [ShippingService],
})

// 4. Compose Agent Modules
const supportAgent = Agent.make(
  "support-agent",
  Module.all(
    Module.instructions(
      "You are a customer support agent for an electronics store. Use the available tools to answer customer questions.",
    ),
    Module.tool(checkInventoryTool, ({ sku }) =>
      Effect.gen(function* () {
        const inventory = yield* InventoryService
        return yield* inventory.getStock(sku)
      }),
    ),
    Module.tool(trackPackageTool, ({ trackingNumber }) =>
      Effect.gen(function* () {
        const shipping = yield* ShippingService
        return yield* shipping.getTrackingStatus(trackingNumber)
      }),
    ),
  ),
)

// 5. Run with Layer Composition
const program = Effect.gen(function* () {
  yield* Console.log("=== Roop Tools & Services Agent ===")

  const events = Runtime.runAgent(supportAgent, {
    sessionId: "support-session-42",
    prompt: "Do you have the 'wireless-keyboard-v2' in stock, and where is package TRK-9900?",
  })

  yield* events.pipe(
    Stream.tap((event) => {
      switch (event._tag) {
        case "ToolCall":
          return Console.log(`\n[Agent invoked tool: ${event.name}] params:`, event.params)
        case "ToolResult":
          return Console.log(`[Tool ${event.name} returned result]:`, event.result)
        case "TextDelta":
          process.stdout.write(event.delta)
          return Effect.void
        case "Finish":
          return Console.log(`\n\n[Run complete: ${event.reason}]`)
        default:
          return Effect.void
      }
    }),
    Stream.runDrain,
    Effect.provide(
      Layer.mergeAll(JournalMemory.JournalMemory, InventoryLive, ShippingLive, DeepSeek.Live),
    ),
  )
})

if (process.argv[1]?.endsWith("02-tools-and-services.ts")) {
  Effect.runPromise(program).catch(console.error)
}
