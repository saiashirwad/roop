import { Layer, Redacted } from "effect"
import { NodeHttpClient } from "@effect/platform-node"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat"

import { ModelCatalogLive } from "./ModelCatalog.ts"

export const DeepSeekLive = (apiKey: string) =>
  ModelCatalogLive([
    {
      id: "deepseek-chat",
      provider: "deepseek",
      description: "DeepSeek V3 chat model via the OpenAI-compatible API",
      layer: Layer.provide(
        OpenAiLanguageModel.model("deepseek-chat"),
        NodeHttpClient.layerUndici,
      ),
    },
  ]).pipe(
    Layer.provide(OpenAiClient.layer({
      apiKey: Redacted.make(apiKey),
      apiUrl: "https://api.deepseek.com",
    })),
    Layer.provide(NodeHttpClient.layerUndici),
  )
