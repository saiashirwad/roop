import { Context, Schema, type Effect } from "effect"
import type { LanguageModel } from "effect/unstable/ai"

import type { ModelOption, RunModelSettings } from "./AgentCapabilities.ts"

export class ModelNotFound extends Schema.TaggedErrorClass<ModelNotFound>()("ModelNotFound", {
  modelId: Schema.String,
}) {}

export class NoModelsConfigured extends Schema.TaggedErrorClass<NoModelsConfigured>()(
  "NoModelsConfigured",
  {
    message: Schema.String,
  },
) {}

export type ModelCatalogService = {
  readonly available: ReadonlyArray<ModelOption>
  readonly defaultModelId: string
  readonly resolve: (
    modelId: string | undefined,
    settings?: RunModelSettings,
  ) => Effect.Effect<LanguageModel.Service, ModelNotFound>
}

export class ModelCatalog extends Context.Service<ModelCatalog, ModelCatalogService>()(
  "roop/ModelCatalog",
) {}
