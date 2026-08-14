import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat"
import { NodeHttpClient } from "@effect/platform-node"
import { ModelCatalogLive } from "@roop/agent/ModelCatalog.ts"
import { Layer, Redacted } from "effect"

export const DeepSeekLive = (apiKey: string) =>
  ModelCatalogLive([
    {
      id: "deepseek-chat",
      provider: "deepseek",
      description: "DeepSeek V3 via the OpenAI-compatible API",
      layer: OpenAiLanguageModel.model("deepseek-chat"),
    },
  ]).pipe(
    Layer.provide(
      OpenAiClient.layer({
        apiKey: Redacted.make(apiKey),
        apiUrl: "https://api.deepseek.com",
      }),
    ),
    Layer.provide(NodeHttpClient.layerUndici),
  )
