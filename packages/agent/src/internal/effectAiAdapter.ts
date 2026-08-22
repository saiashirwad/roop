/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this adapter canonicalizes the JSON-safe audit value at the Effect AI erasure boundary. The runtime checks and two casts below are the required JSON and Effect AI representation checks. */

import { Effect, type Stream } from "effect"
import { LanguageModel, type AiError, type Prompt } from "effect/unstable/ai"
import type { StreamPart } from "effect/unstable/ai/Response"
import type * as Tool from "effect/unstable/ai/Tool"
import type * as Toolkit from "effect/unstable/ai/Toolkit"

/**
 * The immutable input shared by every physical attempt for one model request.
 *
 * This is an internal seam. Public retry and fallback policy belongs in the
 * middleware unit. Keeping this value separate from an attempt prevents a
 * retry from rendering the agent or changing its tool set.
 */
export interface LogicalModelRequest {
  readonly planId: string
  readonly fingerprint: string
  readonly prompt: Prompt.Prompt
  readonly toolkit: Toolkit.WithHandler<Record<string, Tool.Any>>
}

export interface ModelAttempt {
  readonly logical: LogicalModelRequest
  readonly attempt: number
  readonly stream: Stream.Stream<StreamPart<Record<string, Tool.Any>>, AiError.AiError>
}

export interface AttemptState {
  readonly emittedModelPart: boolean
  readonly toolDispatchStarted: boolean
}

export interface ModelAttemptPolicy {
  readonly maxAttempts: number
  readonly shouldRetry?: (error: unknown, state: AttemptState, attempt: number) => boolean
  readonly onAttempt?: (logical: LogicalModelRequest, attempt: number) => void
}

/** Retries are valid only before visible model output or tool dispatch. */
export const canRetryAttempt = (state: AttemptState): boolean =>
  !state.emittedModelPart && !state.toolDispatchStarted

export const defaultModelAttemptPolicy: ModelAttemptPolicy = {
  maxAttempts: 1,
  shouldRetry: (_error, state) => canRetryAttempt(state),
}

/** Return a JSON-safe value with object keys in deterministic order. */
export const stableJsonValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stableJsonValue)
  if (value !== null && typeof value === "object") {
    /* SAFETY: the object branch guarantees a non-null object record. */
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, stableJsonValue(record[key])]),
    )
  }
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "function" || typeof value === "symbol" || value === undefined) {
    return null
  }
  return value
}

/**
 * Build the stable audit fingerprint for a model-facing request.
 * Handlers and live token deltas are intentionally not part of this value.
 */
export const requestFingerprint = (input: {
  readonly planId: string
  readonly prompt: Prompt.Prompt
  readonly toolNames: ReadonlyArray<string>
}): string =>
  JSON.stringify(
    stableJsonValue({
      planId: input.planId,
      prompt: input.prompt,
      toolNames: [...input.toolNames],
    }),
  )

/**
 * Construct one physical model attempt from an immutable logical request.
 * The model is supplied by Effect's environment at the call boundary.
 */
export const modelAttempt = Effect.fn("effectAiAdapter.modelAttempt")(function* (
  logical: LogicalModelRequest,
  attempt: number,
) {
  const model = yield* LanguageModel.LanguageModel
  return {
    logical,
    attempt,
    /* SAFETY: modelAttempt fixes the toolkit to the registry's erased
     * record and keeps the provider's decoded stream error as AiError. */
    stream: model.streamText({
      prompt: logical.prompt,
      toolkit: logical.toolkit,
      concurrency: "unbounded",
    }) as Stream.Stream<StreamPart<Record<string, Tool.Any>>, AiError.AiError>,
  }
})
