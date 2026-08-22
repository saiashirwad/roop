import { Context, Effect, Layer, Schema } from "effect"
import { Tool } from "effect/unstable/ai"

import { Module, type Errors, type Requirements } from "../src/Module.ts"

class Orders extends Context.Service<Orders, { readonly find: (id: string) => string }>()(
  "types/Orders",
) {}

class LookupError extends Schema.TaggedErrorClass<LookupError>()("LookupError", {}) {}
class LayerError extends Schema.TaggedErrorClass<LayerError>()("LayerError", {}) {}

const Lookup = Tool.make("lookup", {
  parameters: Schema.Struct({ id: Schema.String }),
  success: Schema.String,
})

const lookup = Module.tool(Lookup, (_params: { readonly id: string }) =>
  Effect.fail(new LookupError()),
)

const needsOrders = Module.tool(
  Tool.make("find_order", {
    parameters: Schema.Struct({ id: Schema.String }),
    success: Schema.String,
    dependencies: [Orders],
  }),
  (_params) =>
    Effect.gen(function* () {
      const orders = yield* Orders
      return orders.find("id")
    }),
)

const provided = Module.provide(needsOrders, Orders, { find: (id) => id })
const providedLayer = Module.provideLayer(needsOrders, Layer.succeed(Orders, { find: (id) => id }))
const failedLayer = Module.provideLayer(
  needsOrders,
  Layer.effectDiscard(Effect.fail(new LayerError())),
)

export type ModuleTypeRequirements = Requirements<typeof needsOrders>
export type ModuleProvidedRequirements = Requirements<typeof provided>
export type ModuleProvidedLayerRequirements = Requirements<typeof providedLayer>
export type ModuleFailedLayerErrors = Errors<typeof failedLayer>
export type ModuleError = Effect.Error<ReturnType<(typeof lookup)["build"]>>

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T

export type RequirementsPreserved = Assert<Equal<ModuleTypeRequirements, Orders>>
export type RequirementsProvided = Assert<Equal<ModuleProvidedRequirements, never>>
export type RequirementsLayerProvided = Assert<Equal<ModuleProvidedLayerRequirements, never>>
export type LayerFailurePreserved = Assert<Equal<ModuleFailedLayerErrors, LayerError>>
export type FailurePreserved = Assert<Equal<ModuleError, LookupError>>
