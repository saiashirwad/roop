import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat"
import { Plugin } from "@roop/agent/Plugin.ts"
import { Layer, Redacted } from "effect"
import type { HttpClient } from "effect/unstable/http/HttpClient"

export const OpenAiCompatible = (options: {
  readonly name: string
  readonly apiUrl: string
  readonly apiKey: string
  readonly models: ReadonlyArray<{
    readonly id: string
    readonly description?: string | undefined
  }>
}): Plugin<HttpClient> => {
  const client = OpenAiClient.layer({
    apiKey: Redacted.make(options.apiKey),
    apiUrl: options.apiUrl,
  })

  return Plugin({
    name: options.name,
    models: options.models.map((model) => ({
      id: model.id,
      provider: options.name,
      ...(model.description !== undefined ? { description: model.description } : {}),
      layer: OpenAiLanguageModel.model(model.id).pipe(Layer.provide(client)),
    })),
  })
}
