import { type Layer, Schema } from "effect"
import type { LanguageModel } from "effect/unstable/ai"

import { ModelId } from "./ModelId.ts"

export const ModelAd = Schema.Struct({
  id: ModelId,
  provider: Schema.String,
  description: Schema.optionalKey(Schema.String),
})

export type ModelAd = typeof ModelAd.Type

export class ModelNotFound extends Schema.TaggedErrorClass<ModelNotFound>()("ModelNotFound", {
  modelId: ModelId,
}) {}

/**
 * A model contribution: the advertisement `capabilities()` lists plus the
 * layer that builds the `LanguageModel` service. Static plugin composition
 * and runtime `AgentContext.registerModel` both register these.
 */
export type ModelSpec<E, R> = {
  readonly id: ModelId | string
  readonly provider: string
  readonly description?: string | undefined
  readonly layer: Layer.Layer<LanguageModel.LanguageModel, E, R>
}
