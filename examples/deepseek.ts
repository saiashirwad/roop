/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-escape-hatch-assertions, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening, anti-slop/no-cast-deserialization -- DeepSeek JSON wire boundary */

import { Config, Effect, Layer, Option, Redacted, Schema, Stream } from "effect"
import { AiError, LanguageModel, type Response, type Tool } from "effect/unstable/ai"
import * as Sse from "effect/unstable/encoding/Sse"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"

/**
 * Configuration options for DeepSeek LanguageModel.
 */
export interface DeepSeekOptions {
  readonly apiKey?: Redacted.Redacted<string> | string | undefined
  readonly apiUrl?: string | undefined
  readonly model?: string | undefined
  readonly temperature?: number | undefined
  readonly maxTokens?: number | undefined
}

interface OpenAiMessage {
  readonly role: "system" | "user" | "assistant" | "tool"
  readonly content?: string | null | undefined
  readonly reasoning_content?: string | null | undefined
  readonly tool_calls?:
    | ReadonlyArray<{
        readonly id: string
        readonly type: "function"
        readonly function: {
          readonly name: string
          readonly arguments: string
        }
      }>
    | undefined
  readonly tool_call_id?: string | undefined
}

interface OpenAiTool {
  readonly type: "function"
  readonly function: {
    readonly name: string
    readonly description?: string | undefined
    readonly parameters: unknown
  }
}

interface OpenAiChunkChoice {
  readonly delta?:
    | {
        readonly content?: string | null | undefined
        readonly reasoning_content?: string | null | undefined
        readonly tool_calls?:
          | ReadonlyArray<{
              readonly index: number
              readonly id?: string | undefined
              readonly type?: "function" | undefined
              readonly function?:
                | {
                    readonly name?: string | undefined
                    readonly arguments?: string | undefined
                  }
                | undefined
            }>
          | undefined
      }
    | undefined
  readonly finish_reason?: string | null | undefined
}

interface OpenAiChunk {
  readonly id?: string | undefined
  readonly choices?: ReadonlyArray<OpenAiChunkChoice> | undefined
  readonly usage?:
    | {
        readonly prompt_tokens?: number | undefined
        readonly completion_tokens?: number | undefined
        readonly total_tokens?: number | undefined
      }
    | undefined
}

interface OpenAiResponseChoice {
  readonly message?:
    | {
        readonly role: string
        readonly content?: string | null | undefined
        readonly reasoning_content?: string | null | undefined
        readonly tool_calls?:
          | ReadonlyArray<{
              readonly id: string
              readonly type: "function"
              readonly function: {
                readonly name: string
                readonly arguments: string
              }
            }>
          | undefined
      }
    | undefined
  readonly finish_reason?: string | null | undefined
}

interface OpenAiResponse {
  readonly id?: string | undefined
  readonly choices?: ReadonlyArray<OpenAiResponseChoice> | undefined
  readonly usage?:
    | {
        readonly prompt_tokens?: number | undefined
        readonly completion_tokens?: number | undefined
        readonly total_tokens?: number | undefined
      }
    | undefined
}

const safeParseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw || "{}")
  } catch {
    return raw
  }
}

const safeParseChunk = (raw: string): OpenAiChunk | undefined => {
  try {
    return JSON.parse(raw) as OpenAiChunk
  } catch {
    return undefined
  }
}

const mapFinishReason = (reason?: string | null): Response.FinishReason => {
  switch (reason) {
    case "stop":
      return "stop"
    case "tool_calls":
      return "tool-calls"
    case "length":
      return "length"
    case "content_filter":
      return "content-filter"
    default:
      return "unknown"
  }
}

const buildMessages = (
  prompt: LanguageModel.ProviderOptions["prompt"],
): ReadonlyArray<OpenAiMessage> => {
  const messages: OpenAiMessage[] = []

  for (const message of prompt.content) {
    switch (message.role) {
      case "system": {
        messages.push({
          role: "system",
          content: message.content,
        })
        break
      }
      case "user": {
        const textParts: string[] = []
        for (const part of message.content) {
          if (part.type === "text") {
            textParts.push(part.text)
          }
        }
        messages.push({
          role: "user",
          content: textParts.join("\n"),
        })
        break
      }
      case "assistant": {
        const textParts: string[] = []
        let reasoning: string | undefined
        const toolCalls: Array<{
          readonly id: string
          readonly type: "function"
          readonly function: { readonly name: string; readonly arguments: string }
        }> = []
        const toolResults: Array<{ readonly id: string; readonly result: string }> = []

        for (const part of message.content) {
          if (part.type === "text") {
            textParts.push(part.text)
          } else if (part.type === "reasoning") {
            reasoning = part.text
          } else if (part.type === "tool-call") {
            toolCalls.push({
              id: part.id,
              type: "function",
              function: {
                name: part.name,
                arguments:
                  typeof part.params === "string" ? part.params : JSON.stringify(part.params),
              },
            })
          } else if (part.type === "tool-result") {
            toolResults.push({
              id: part.id,
              result: typeof part.result === "string" ? part.result : JSON.stringify(part.result),
            })
          }
        }

        if (textParts.length > 0 || toolCalls.length > 0 || reasoning !== undefined) {
          const assistantMsg: {
            role: "assistant"
            content: string | null
            reasoning_content?: string | undefined
            tool_calls?:
              | ReadonlyArray<{
                  readonly id: string
                  readonly type: "function"
                  readonly function: { readonly name: string; readonly arguments: string }
                }>
              | undefined
          } = {
            role: "assistant",
            content: textParts.join("\n") || null,
          }
          if (reasoning !== undefined) assistantMsg.reasoning_content = reasoning
          if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls
          messages.push(assistantMsg)
        }

        for (const tr of toolResults) {
          messages.push({
            role: "tool",
            tool_call_id: tr.id,
            content: tr.result,
          })
        }
        break
      }
    }
  }

  return messages
}

const buildTools = (tools: ReadonlyArray<Tool.Any>): ReadonlyArray<OpenAiTool> | undefined => {
  if (tools.length === 0) return undefined
  return tools.map((tool) => {
    const description =
      typeof tool.description === "string"
        ? tool.description
        : Option.isOption(tool.description) && Option.isSome(tool.description)
          ? tool.description.value
          : undefined
    const schemaDoc = Schema.toJsonSchemaDocument(tool.parametersSchema)
    const fnObj: {
      name: string
      parameters: unknown
      description?: string | undefined
    } = {
      name: tool.name,
      parameters: schemaDoc.schema,
    }
    if (description !== undefined) fnObj.description = description
    return {
      type: "function" as const,
      function: fnObj,
    }
  })
}

/**
 * Creates a DeepSeek LanguageModel service.
 */
export const make = (
  options?: DeepSeekOptions,
): Effect.Effect<LanguageModel.Service, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient
    const resolvedApiKey =
      options?.apiKey !== undefined
        ? typeof options.apiKey === "string"
          ? options.apiKey
          : Redacted.value(options.apiKey)
        : yield* Config.redacted("DEEPSEEK_API_KEY").pipe(
            Effect.map(Redacted.value),
            Effect.orElseSucceed(() => process.env["DEEPSEEK_API_KEY"] ?? ""),
          )

    const apiUrl = options?.apiUrl ?? "https://api.deepseek.com"
    const model = options?.model ?? "deepseek-chat"

    return yield* LanguageModel.make({
      generateText: (providerOptions) =>
        Effect.gen(function* () {
          const messages = buildMessages(providerOptions.prompt)
          const tools = buildTools(providerOptions.tools)

          const payload: Record<string, unknown> = {
            model,
            messages,
            stream: false,
          }
          if (tools !== undefined) payload["tools"] = tools
          if (options?.temperature !== undefined) payload["temperature"] = options.temperature
          if (options?.maxTokens !== undefined) payload["max_tokens"] = options.maxTokens

          const request = HttpClientRequest.post(`${apiUrl}/chat/completions`).pipe(
            HttpClientRequest.bearerToken(resolvedApiKey),
            HttpClientRequest.jsonBody(payload),
          )

          const response = yield* request.pipe(
            Effect.flatMap(httpClient.execute),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(Schema.Unknown)),
            Effect.map((json) => json as OpenAiResponse),
            Effect.mapError((error) =>
              AiError.make({
                module: "DeepSeek",
                method: "generateText",
                reason: new AiError.UnknownError({ error }),
              }),
            ),
          )

          const parts: Response.PartEncoded[] = []
          const choice = response.choices?.[0]

          if (choice?.message?.reasoning_content) {
            parts.push({
              type: "reasoning",
              text: choice.message.reasoning_content,
            })
          }

          if (choice?.message?.content) {
            parts.push({
              type: "text",
              text: choice.message.content,
            })
          }

          if (choice?.message?.tool_calls) {
            for (const call of choice.message.tool_calls) {
              const parsedParams = safeParseJson(call.function.arguments)
              parts.push({
                type: "tool-call",
                id: call.id,
                name: call.function.name,
                params: parsedParams,
                providerExecuted: false,
              })
            }
          }

          parts.push({
            type: "finish",
            reason: mapFinishReason(choice?.finish_reason),
            usage: {
              inputTokens: {
                total: response.usage?.prompt_tokens,
                uncached: response.usage?.prompt_tokens,
              },
              outputTokens: {
                total: response.usage?.completion_tokens,
                text: response.usage?.completion_tokens,
              },
            },
          })

          return parts
        }),

      streamText: (providerOptions) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const messages = buildMessages(providerOptions.prompt)
            const tools = buildTools(providerOptions.tools)

            const payload: Record<string, unknown> = {
              model,
              messages,
              stream: true,
            }
            if (tools !== undefined) payload["tools"] = tools
            if (options?.temperature !== undefined) payload["temperature"] = options.temperature
            if (options?.maxTokens !== undefined) payload["max_tokens"] = options.maxTokens

            const request = HttpClientRequest.post(`${apiUrl}/chat/completions`).pipe(
              HttpClientRequest.bearerToken(resolvedApiKey),
              HttpClientRequest.jsonBody(payload),
            )

            const response = yield* request.pipe(
              Effect.flatMap(httpClient.execute),
              Effect.mapError((error) =>
                AiError.make({
                  module: "DeepSeek",
                  method: "streamText",
                  reason: new AiError.UnknownError({ error }),
                }),
              ),
            )

            interface AccumulatedToolCall {
              id: string
              name: string
              arguments: string
            }

            const toolCallsAccumulator = new Map<number, AccumulatedToolCall>()

            return response.stream.pipe(
              Stream.decodeText(),
              Stream.pipeThroughChannel(Sse.decode()),
              Stream.mapError((error) =>
                AiError.make({
                  module: "DeepSeek",
                  method: "streamText",
                  reason: new AiError.UnknownError({ error }),
                }),
              ),
              Stream.takeUntil((event) => event.data === "[DONE]"),
              Stream.flatMap(
                (event): Stream.Stream<Response.StreamPartEncoded, AiError.AiError> => {
                  if (event.data === "[DONE]") {
                    return Stream.empty
                  }

                  const chunk = safeParseChunk(event.data)
                  if (!chunk) return Stream.empty

                  const choice = chunk.choices?.[0]
                  if (!choice) return Stream.empty

                  const parts: Response.StreamPartEncoded[] = []

                  if (choice.delta?.reasoning_content) {
                    parts.push({
                      type: "reasoning-delta",
                      id: "reasoning",
                      delta: choice.delta.reasoning_content,
                    })
                  }

                  if (choice.delta?.content) {
                    parts.push({
                      type: "text-delta",
                      id: "text",
                      delta: choice.delta.content,
                    })
                  }

                  if (choice.delta?.tool_calls) {
                    for (const tc of choice.delta.tool_calls) {
                      const existing = toolCallsAccumulator.get(tc.index) ?? {
                        id: tc.id ?? `tool_${tc.index}`,
                        name: tc.function?.name ?? "",
                        arguments: "",
                      }
                      if (tc.id) existing.id = tc.id
                      if (tc.function?.name) existing.name = tc.function.name
                      if (tc.function?.arguments) existing.arguments += tc.function.arguments
                      toolCallsAccumulator.set(tc.index, existing)
                    }
                  }

                  if (choice.finish_reason) {
                    if (toolCallsAccumulator.size > 0) {
                      for (const call of toolCallsAccumulator.values()) {
                        const parsedParams = safeParseJson(call.arguments)
                        parts.push({
                          type: "tool-call",
                          id: call.id,
                          name: call.name,
                          params: parsedParams,
                          providerExecuted: false,
                        })
                      }
                      toolCallsAccumulator.clear()
                    }

                    parts.push({
                      type: "finish",
                      reason: mapFinishReason(choice.finish_reason),
                      usage: {
                        inputTokens: {
                          total: chunk.usage?.prompt_tokens,
                          uncached: chunk.usage?.prompt_tokens,
                        },
                        outputTokens: {
                          total: chunk.usage?.completion_tokens,
                          text: chunk.usage?.completion_tokens,
                        },
                      },
                    })
                  }

                  return Stream.fromIterable(parts)
                },
              ),
            )
          }),
        ),
    })
  })

/**
 * Layer that provides DeepSeek as `LanguageModel.LanguageModel`.
 */
export const layer = (options?: DeepSeekOptions): Layer.Layer<LanguageModel.LanguageModel> =>
  Layer.effect(LanguageModel.LanguageModel, make(options)).pipe(
    Layer.provide(FetchHttpClient.layer),
  )

/**
 * Pre-configured live layer reading `DEEPSEEK_API_KEY` with default `deepseek-chat` model.
 */
export const Live: Layer.Layer<LanguageModel.LanguageModel> = layer()

/**
 * Pre-configured live layer for DeepSeek-R1 reasoning model (`deepseek-reasoner`).
 */
export const reasonerLive: Layer.Layer<LanguageModel.LanguageModel> = layer({
  model: "deepseek-reasoner",
})

/**
 * Pre-configured live layer for DeepSeek-V3 chat model (`deepseek-chat`).
 */
export const chatLive: Layer.Layer<LanguageModel.LanguageModel> = layer({
  model: "deepseek-chat",
})

export const DeepSeek = {
  make,
  layer,
  Live,
  reasonerLive,
  chatLive,
}
