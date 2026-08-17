import { Context, Effect, Layer, Scope, Schema } from "effect"
import { LanguageModel } from "effect/unstable/ai"

import { ModelId } from "./DomainIds.ts"

export const ModelAd = Schema.Struct({
  id: ModelId,
  provider: Schema.String,
  description: Schema.optionalKey(Schema.String),
})

export type ModelAd = typeof ModelAd.Type

export class ModelNotFound extends Schema.TaggedErrorClass<ModelNotFound>()("ModelNotFound", {
  modelId: ModelId,
}) {}

/** A model contribution: its advertisement plus the layer that builds it. */
export type ModelSpec<E, R> = {
  readonly id: ModelId | string
  readonly provider: string
  readonly description?: string | undefined
  readonly layer: Layer.Layer<LanguageModel.LanguageModel, E, R>
}

export class ModelCatalog extends Context.Service<
  ModelCatalog,
  {
    readonly ads: ReadonlyArray<ModelAd>
    readonly defaultModelId: ModelId
    readonly resolve: (
      modelId: ModelId | string | undefined,
    ) => Effect.Effect<LanguageModel.Service, ModelNotFound>
  }
>()("roop/ModelCatalog") {}

/**
 * Build all configured models in the agent's scope and expose an immutable
 * lookup catalog. Later model specs with the same id override earlier specs,
 * matching Toolkit.merge's composition rule.
 */
export const layer = <E, R>(
  specs: ReadonlyArray<ModelSpec<E, R>>,
): Layer.Layer<ModelCatalog, E, R> =>
  Layer.effect(
    ModelCatalog,
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const entries = yield* Effect.forEach(specs, (spec) =>
        Layer.buildWithScope(spec.layer, scope).pipe(
          Effect.map((context) => ({
            ad: {
              id: ModelId.make(spec.id),
              provider: spec.provider,
              ...(spec.description === undefined ? undefined : { description: spec.description }),
            },
            model: Context.get(context, LanguageModel.LanguageModel),
          })),
        ),
      )
      const byId = new Map<ModelId, LanguageModel.Service>()
      const adsById = new Map<ModelId, ModelAd>()
      for (const entry of entries) {
        byId.set(entry.ad.id, entry.model)
        adsById.set(entry.ad.id, entry.ad)
      }
      const ads = [...adsById.values()]
      const defaultModelId = ads.at(-1)?.id ?? ModelId.make("")

      return ModelCatalog.of({
        ads,
        defaultModelId,
        resolve: (modelId) => {
          const resolvedId = ModelId.make(modelId ?? defaultModelId)
          const model = byId.get(resolvedId)
          return model === undefined
            ? Effect.fail(new ModelNotFound({ modelId: resolvedId }))
            : Effect.succeed(model)
        },
      })
    }),
  )
