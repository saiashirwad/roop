/**
 * Multi-provider model catalog (OpenAI Chat Completions via `@effect/ai-openai-compat`).
 *
 * - Kimi Coding Plan → `https://api.kimi.com/coding/v1` (`KIMI_API_KEY`)
 * - Z.AI Coding Plan → `https://api.z.ai/api/coding/paas/v4` (`ZAI_API_KEY` / `Z_AI_API_KEY`)
 * - DeepSeek API → `https://api.deepseek.com` (`DEEPSEEK_API_KEY`)
 *
 * Effort / thinking go as passthrough body fields.
 */
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat"
import type { ModelOption } from "@roop/core/AgentCapabilities.ts"
import {
  ModelCatalog,
  ModelNotFound,
  NoModelsConfigured,
  type ModelCatalogService,
} from "@roop/core/ModelCatalog.ts"
import { Config, Effect, Layer, Option, Redacted } from "effect"
import { FetchHttpClient } from "effect/unstable/http"

import {
  DEFAULT_MODEL_PREFERENCE,
  DEEPSEEK_MODELS,
  KIMI_MODELS,
  requestConfigFor,
  ZAI_MODELS,
  type ModelDefinition,
} from "./models.ts"

export { ModelCatalog, ModelNotFound, NoModelsConfigured, type ModelCatalogService }

type CatalogEntry = {
  readonly definition: ModelDefinition
  readonly client: OpenAiClient.Service
}

const toOption = (definition: ModelDefinition): ModelOption => ({
  id: definition.id,
  name: definition.name,
  provider: definition.provider,
  ...(definition.description !== undefined ? { description: definition.description } : {}),
  settings: {
    ...(definition.effort !== undefined
      ? {
          effort: {
            levels: [...definition.effort.levels],
            default: definition.effort.default,
          },
        }
      : {}),
    ...(definition.thinking !== undefined
      ? {
          thinking: {
            canDisable: definition.thinking.canDisable,
            default: definition.thinking.default,
          },
        }
      : {}),
  },
})

const pickDefaultId = (ids: ReadonlyArray<string>): string => {
  for (const preferred of DEFAULT_MODEL_PREFERENCE) {
    if (ids.includes(preferred)) return preferred
  }
  return ids[0]!
}

const loadClient = (
  apiKey: Redacted.Redacted<string>,
  apiUrl: string,
): Effect.Effect<OpenAiClient.Service, never, never> =>
  OpenAiClient.make({ apiKey, apiUrl }).pipe(Effect.provide(FetchHttpClient.layer))

const entriesFor = (
  definitions: ReadonlyArray<ModelDefinition>,
  apiKey: Option.Option<Redacted.Redacted<string>>,
  apiUrl: string,
): Effect.Effect<ReadonlyArray<CatalogEntry>> =>
  Option.match(apiKey, {
    onNone: () => Effect.succeed([] as ReadonlyArray<CatalogEntry>),
    onSome: (key) =>
      Effect.gen(function* () {
        const client = yield* loadClient(key, apiUrl)
        return definitions.map((definition) => ({ definition, client }))
      }),
  })

/** Catalog from env keys; fails with `NoModelsConfigured` when none are available. */
export const makeModelCatalog: Effect.Effect<ModelCatalogService, NoModelsConfigured> = Effect.gen(
  function* () {
    const kimiKey = yield* Config.option(Config.redacted("KIMI_API_KEY"))
    const zaiKey = yield* Config.option(
      Config.redacted("ZAI_API_KEY").pipe(Config.orElse(() => Config.redacted("Z_AI_API_KEY"))),
    )
    const deepseekKey = yield* Config.option(Config.redacted("DEEPSEEK_API_KEY"))

    const kimi = yield* entriesFor(KIMI_MODELS, kimiKey, "https://api.kimi.com/coding/v1")
    const zai = yield* entriesFor(ZAI_MODELS, zaiKey, "https://api.z.ai/api/coding/paas/v4")
    const deepseek = yield* entriesFor(DEEPSEEK_MODELS, deepseekKey, "https://api.deepseek.com")

    const entries = [...kimi, ...zai, ...deepseek]
    if (entries.length === 0) {
      return yield* new NoModelsConfigured({
        message:
          "No model API keys found. Set KIMI_API_KEY, ZAI_API_KEY (or Z_AI_API_KEY), and/or DEEPSEEK_API_KEY.",
      })
    }

    const byId = new Map(entries.map((entry) => [entry.definition.id, entry]))
    const available = entries.map((entry) => toOption(entry.definition))
    const defaultModelId = pickDefaultId(available.map((m) => m.id))

    return {
      available,
      defaultModelId,
      resolve: (modelId, settings) =>
        Effect.gen(function* () {
          const id = modelId ?? defaultModelId
          const entry = byId.get(id)
          if (entry === undefined) {
            return yield* new ModelNotFound({ modelId: id })
          }
          const config = requestConfigFor(entry.definition, settings)
          return yield* OpenAiLanguageModel.make({
            model: entry.definition.apiModel,
            config,
          }).pipe(Effect.provideService(OpenAiClient.OpenAiClient, entry.client))
        }),
    } satisfies ModelCatalogService
  },
).pipe(
  Effect.mapError((error) =>
    error instanceof NoModelsConfigured
      ? error
      : new NoModelsConfigured({
          message: `Failed to load model configuration: ${String(error)}`,
        }),
  ),
)

export const ModelCatalogLive: Layer.Layer<ModelCatalog, NoModelsConfigured> = Layer.effect(
  ModelCatalog,
  makeModelCatalog,
)
