import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat"
import {
  DEEPSEEK_MODELS,
  KIMI_MODELS,
  requestConfigFor,
  ZAI_MODELS,
  type ModelDefinition,
} from "@roop/pack/models.ts"
import { Effect, Redacted } from "effect"
import type { LanguageModel } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"

import type { Env } from "./env.ts"

type Provider = {
  readonly apiKey: string | undefined
  readonly apiUrl: string
  readonly models: ReadonlyArray<ModelDefinition>
}

/**
 * Resolve a language model from worker secrets (first provider with a key
 * wins, same preference order as the local server). Returns undefined when
 * no key is configured — the room reports that as a RunFailed event.
 */
export const resolveRoomModel = (env: Env): Effect.Effect<LanguageModel.Service | undefined> =>
  Effect.gen(function* () {
    const candidates: ReadonlyArray<Provider> = [
      { apiKey: env.KIMI_API_KEY, apiUrl: "https://api.kimi.com/coding/v1", models: KIMI_MODELS },
      {
        apiKey: env.ZAI_API_KEY ?? env.Z_AI_API_KEY,
        apiUrl: "https://api.z.ai/api/coding/paas/v4",
        models: ZAI_MODELS,
      },
      {
        apiKey: env.DEEPSEEK_API_KEY,
        apiUrl: "https://api.deepseek.com",
        models: DEEPSEEK_MODELS,
      },
    ]
    const provider = candidates.find(
      (candidate) => candidate.apiKey !== undefined && candidate.apiKey.length > 0,
    )
    const definition = provider?.models[0]
    if (provider === undefined || definition === undefined) {
      return undefined
    }

    const client = yield* OpenAiClient.make({
      apiKey: Redacted.make(provider.apiKey!),
      apiUrl: provider.apiUrl,
    }).pipe(Effect.provide(FetchHttpClient.layer))

    return yield* OpenAiLanguageModel.make({
      model: definition.apiModel,
      config: requestConfigFor(definition),
    }).pipe(Effect.provideService(OpenAiClient.OpenAiClient, client))
  })
