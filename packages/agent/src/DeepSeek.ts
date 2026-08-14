import { Layer, Redacted } from "effect"
import { NodeHttpClient } from "@effect/platform-node"
import { OpenAiLanguageModel } from "@effect/ai-openai-compat"

import { ModelCatalogLive } from "./ModelCatalog.ts"

export const DeepSeekCatalog = (apiKey: string) =>
  ModelCatalogLive([
    {
      id: "deepseek-chat",
      provider: "deepseek",
      description: "DeepSeek V3 chat model via the OpenAI-compatible API",
      layer: Layer.provide(
        OpenAiLanguageModel.model("deepseek-chat", {
          apiKey: Redacted.make(apiKey),
          apiUrl: "https://api.deepseek.com",
        }),
        NodeHttpClient.layerUndici,
      ),
    },
  ])

export const DeepSeekLive = (apiKey: string) => DeepSeekCatalog(apiKey)
