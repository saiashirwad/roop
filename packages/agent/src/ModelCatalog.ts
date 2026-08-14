import { Context, Effect, Layer, Schema } from "effect"
import { LanguageModel, Model } from "effect/unstable/ai"

export const ModelAd = Schema.Struct({
  id: Schema.String,
  provider: Schema.String,
  description: Schema.optionalKey(Schema.String),
})

export type ModelAd = typeof ModelAd.Type

export class ModelNotFound extends Schema.TaggedErrorClass<ModelNotFound>()("ModelNotFound", {
  modelId: Schema.String,
}) {}

export type ModelSpec<E, R> = {
  readonly id: string
  readonly provider: string
  readonly description?: string | undefined
  readonly layer: Layer.Layer<LanguageModel.LanguageModel | Model.ProviderName | Model.ModelName, E, R>
}

export class ModelCatalog extends Context.Service<
  ModelCatalog,
  {
    readonly list: () => Effect.Effect<ReadonlyArray<ModelAd>>
    readonly defaultModelId: () => Effect.Effect<string>
    readonly resolve: (
      modelId: string | undefined,
    ) => Effect.Effect<LanguageModel.Service, ModelNotFound>
  }
>()("roop/ModelCatalog") {}

export const ModelCatalogLive = <E, R>(specs: ReadonlyArray<ModelSpec<E, R>>) =>
  Layer.effect(
    ModelCatalog,
    Effect.gen(function* () {
      const entries: Array<{ readonly ad: ModelAd; readonly model: LanguageModel.Service }> = []
      for (const spec of specs) {
        const context = yield* Layer.build(spec.layer)
        entries.push({
          ad: {
            id: spec.id,
            provider: spec.provider,
            ...(spec.description !== undefined ? { description: spec.description } : {}),
          },
          model: Context.get(context, LanguageModel.LanguageModel),
        })
      }

      const resolve = (modelId: string | undefined) => {
        const id = modelId ?? entries[0]?.ad.id ?? ""
        const entry = entries.find((candidate) => candidate.ad.id === id)
        return entry === undefined
          ? Effect.fail(new ModelNotFound({ modelId: modelId ?? id }))
          : Effect.succeed(entry.model)
      }

      return ModelCatalog.of({
        list: () => Effect.sync(() => entries.map((entry) => entry.ad)),
        defaultModelId: () => Effect.sync(() => entries[0]?.ad.id ?? ""),
        resolve,
      })
    }),
  )
