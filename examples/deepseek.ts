/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-escape-hatch-assertions, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening, anti-slop/no-cast-deserialization, anti-slop/no-conditional-empty-object-spread -- DeepSeek JSON wire boundary; optional wire keys are omitted, not sent as undefined */

import { Config, Effect, Layer, Redacted, Schema, Stream } from "effect"
import { AiError, LanguageModel, type Response, type Tool } from "effect/unstable/ai"
import * as Sse from "effect/unstable/encoding/Sse"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"

/** Configuration options for the DeepSeek LanguageModel. */
export interface DeepSeekOptions {
  readonly apiKey?: Redacted.Redacted<string> | string | undefined
  readonly apiUrl?: string | undefined
  readonly model?: string | undefined
  readonly temperature?: number | undefined
  readonly maxTokens?: number | undefined
}

interface OpenAiToolCall {
  readonly id: string
  readonly type: "function"
  readonly function: { readonly name: string; readonly arguments: string }
}

interface OpenAiMessage {
  readonly role: "system" | "user" | "assistant" | "tool"
  readonly content?: string | null | undefined
  readonly reasoning_content?: string | undefined
  readonly tool_calls?: ReadonlyArray<OpenAiToolCall> | undefined
  readonly tool_call_id?: string | undefined
}

interface OpenAiUsage {
  readonly prompt_tokens?: number | undefined
  readonly completion_tokens?: number | undefined
  readonly prompt_cache_hit_tokens?: number | undefined
  readonly prompt_cache_miss_tokens?: number | undefined
  readonly completion_tokens_details?:
    | { readonly reasoning_tokens?: number | undefined }
    | undefined
}

interface OpenAiResponse {
  readonly choices?:
    | ReadonlyArray<{
        readonly message?:
          | {
              readonly content?: string | null | undefined
              readonly reasoning_content?: string | null | undefined
              readonly tool_calls?: ReadonlyArray<OpenAiToolCall> | undefined
            }
          | undefined
        readonly finish_reason?: string | null | undefined
      }>
    | undefined
  readonly usage?: OpenAiUsage | undefined
}

interface OpenAiChunk {
  readonly choices?:
    | ReadonlyArray<{
        readonly delta?:
          | {
              readonly content?: string | null | undefined
              readonly reasoning_content?: string | null | undefined
              readonly tool_calls?:
                | ReadonlyArray<{
                    readonly index: number
                    readonly id?: string | undefined
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
      }>
    | undefined
  readonly usage?: OpenAiUsage | null | undefined
}

const parseJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw === "" ? "{}" : raw)
  } catch {
    return raw
  }
}

const finishReason = (reason: string | null | undefined): Response.FinishReason => {
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

const usage = (raw: OpenAiUsage | null | undefined): typeof Response.Usage.Encoded => ({
  inputTokens: {
    total: raw?.prompt_tokens,
    uncached: raw?.prompt_cache_miss_tokens ?? raw?.prompt_tokens,
    cacheRead: raw?.prompt_cache_hit_tokens,
    cacheWrite: undefined,
  },
  outputTokens: {
    total: raw?.completion_tokens,
    text: raw?.completion_tokens,
    reasoning: raw?.completion_tokens_details?.reasoning_tokens,
  },
})

const toolCallPart = (
  call: OpenAiToolCall,
): Extract<Response.PartEncoded, { type: "tool-call" }> => ({
  type: "tool-call",
  id: call.id,
  name: call.function.name,
  params: parseJson(call.function.arguments),
  providerExecuted: false,
})

/** Project an Effect AI prompt onto the OpenAI-compatible message list DeepSeek expects. */
const toMessages = (
  prompt: LanguageModel.ProviderOptions["prompt"],
): ReadonlyArray<OpenAiMessage> =>
  prompt.content.flatMap((message): ReadonlyArray<OpenAiMessage> => {
    switch (message.role) {
      case "system":
        return [{ role: "system", content: message.content }]
      case "user":
        return [
          {
            role: "user",
            content: message.content
              .flatMap((part) => (part.type === "text" ? [part.text] : []))
              .join("\n"),
          },
        ]
      case "assistant": {
        const text: Array<string> = []
        const toolCalls: Array<OpenAiToolCall> = []
        const toolResults: Array<OpenAiMessage> = []
        let reasoning: string | undefined
        for (const part of message.content) {
          switch (part.type) {
            case "text":
              text.push(part.text)
              break
            case "reasoning":
              reasoning = part.text
              break
            case "tool-call":
              toolCalls.push({
                id: part.id,
                type: "function",
                function: { name: part.name, arguments: JSON.stringify(part.params) },
              })
              break
            case "tool-result":
              toolResults.push({
                role: "tool",
                tool_call_id: part.id,
                content:
                  typeof part.result === "string" ? part.result : JSON.stringify(part.result),
              })
              break
            default:
              break
          }
        }
        const assistant: Array<OpenAiMessage> =
          text.length === 0 && toolCalls.length === 0 && reasoning === undefined
            ? []
            : [
                {
                  role: "assistant",
                  content: text.length === 0 ? null : text.join("\n"),
                  ...(reasoning === undefined ? {} : { reasoning_content: reasoning }),
                  ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
                },
              ]
        return [...assistant, ...toolResults]
      }
      case "tool":
        return message.content.flatMap(
          (part): ReadonlyArray<OpenAiMessage> =>
            part.type === "tool-result"
              ? [
                  {
                    role: "tool",
                    tool_call_id: part.id,
                    content:
                      typeof part.result === "string" ? part.result : JSON.stringify(part.result),
                  },
                ]
              : [],
        )
    }
  })

const toTools = (tools: ReadonlyArray<Tool.Any>) =>
  tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      ...(tool.description === undefined ? {} : { description: tool.description }),
      parameters: Schema.toJsonSchemaDocument(tool.parametersSchema).schema,
    },
  }))

/** Creates a DeepSeek `LanguageModel` service over the OpenAI-compatible chat API. */
export const make = (
  options?: DeepSeekOptions,
): Effect.Effect<LanguageModel.Service, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient
    const apiKey =
      options?.apiKey === undefined
        ? yield* Config.redacted("DEEPSEEK_API_KEY").pipe(
            Effect.map(Redacted.value),
            Effect.orElseSucceed(() => ""),
          )
        : typeof options.apiKey === "string"
          ? options.apiKey
          : Redacted.value(options.apiKey)
    const apiUrl = options?.apiUrl ?? "https://api.deepseek.com"
    const model = options?.model ?? "deepseek-chat"

    const aiError = (method: string) => (error: unknown) =>
      AiError.make({
        module: "DeepSeek",
        method,
        reason: new AiError.UnknownError({
          description: error instanceof Error ? error.message : String(error),
        }),
      })

    const completions = (
      method: string,
      providerOptions: LanguageModel.ProviderOptions,
      stream: boolean,
    ) =>
      HttpClientRequest.post(`${apiUrl}/chat/completions`).pipe(
        HttpClientRequest.bearerToken(apiKey),
        HttpClientRequest.bodyJson({
          model,
          messages: toMessages(providerOptions.prompt),
          stream,
          ...(providerOptions.tools.length === 0 ? {} : { tools: toTools(providerOptions.tools) }),
          ...(options?.temperature === undefined ? {} : { temperature: options.temperature }),
          ...(options?.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
        }),
        Effect.flatMap(httpClient.execute),
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.mapError(aiError(method)),
      )

    return yield* LanguageModel.make({
      generateText: (providerOptions) =>
        Effect.gen(function* () {
          const response = yield* completions("generateText", providerOptions, false)
          const body = (yield* response.json.pipe(
            Effect.mapError(aiError("generateText")),
          )) as OpenAiResponse
          const choice = body.choices?.[0]
          const parts: Array<Response.PartEncoded> = []
          if (choice?.message?.reasoning_content) {
            parts.push({ type: "reasoning", text: choice.message.reasoning_content })
          }
          if (choice?.message?.content) {
            parts.push({ type: "text", text: choice.message.content })
          }
          for (const call of choice?.message?.tool_calls ?? []) {
            parts.push(toolCallPart(call))
          }
          parts.push({
            type: "finish",
            reason: finishReason(choice?.finish_reason),
            usage: usage(body.usage),
            response: undefined,
          })
          return parts
        }),

      streamText: (providerOptions) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const response = yield* completions("streamText", providerOptions, true)
            // DeepSeek streams tool-call arguments in fragments keyed by index.
            const toolCalls = new Map<number, { id: string; name: string; arguments: string }>()
            return response.stream.pipe(
              Stream.decodeText(),
              Stream.pipeThroughChannel(Sse.decode()),
              Stream.mapError(aiError("streamText")),
              Stream.takeUntil((event) => event.data === "[DONE]"),
              Stream.flatMap((event) => {
                if (event.data === "[DONE]") return Stream.empty
                const chunk = parseJson(event.data) as OpenAiChunk
                const choice = chunk.choices?.[0]
                if (choice === undefined) return Stream.empty
                const parts: Array<Response.StreamPartEncoded> = []
                if (choice.delta?.reasoning_content) {
                  parts.push({
                    type: "reasoning-delta",
                    id: "reasoning",
                    delta: choice.delta.reasoning_content,
                  })
                }
                if (choice.delta?.content) {
                  parts.push({ type: "text-delta", id: "text", delta: choice.delta.content })
                }
                for (const fragment of choice.delta?.tool_calls ?? []) {
                  const call = toolCalls.get(fragment.index) ?? {
                    id: fragment.id ?? `tool_${fragment.index}`,
                    name: "",
                    arguments: "",
                  }
                  if (fragment.id) call.id = fragment.id
                  if (fragment.function?.name) call.name = fragment.function.name
                  if (fragment.function?.arguments) call.arguments += fragment.function.arguments
                  toolCalls.set(fragment.index, call)
                }
                if (choice.finish_reason) {
                  for (const call of toolCalls.values()) {
                    parts.push(
                      toolCallPart({
                        id: call.id,
                        type: "function",
                        function: { name: call.name, arguments: call.arguments },
                      }),
                    )
                  }
                  toolCalls.clear()
                  parts.push({
                    type: "finish",
                    reason: finishReason(choice.finish_reason),
                    usage: usage(chunk.usage),
                    response: undefined,
                  })
                }
                return Stream.fromIterable(parts)
              }),
            )
          }),
        ),
    })
  })

/** Layer that provides DeepSeek as `LanguageModel.LanguageModel`. */
export const layer = (options?: DeepSeekOptions): Layer.Layer<LanguageModel.LanguageModel> =>
  Layer.effect(LanguageModel.LanguageModel, make(options)).pipe(
    Layer.provide(FetchHttpClient.layer),
  )

/** Reads `DEEPSEEK_API_KEY`; default `deepseek-chat` (DeepSeek-V3). */
export const Live: Layer.Layer<LanguageModel.LanguageModel> = layer()

/** DeepSeek-R1 (`deepseek-reasoner`) with `ReasoningDelta` streaming. */
export const reasonerLive: Layer.Layer<LanguageModel.LanguageModel> = layer({
  model: "deepseek-reasoner",
})

export const chatLive: Layer.Layer<LanguageModel.LanguageModel> = layer({ model: "deepseek-chat" })

export const DeepSeek = { make, layer, Live, reasonerLive, chatLive }
