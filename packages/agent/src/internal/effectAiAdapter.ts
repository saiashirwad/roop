/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this adapter is the single JSON canonicalization and Effect AI erasure boundary; values entering it are untyped by design. */

import type { Stream } from "effect"
import type { AiError, LanguageModel, Prompt } from "effect/unstable/ai"
import type { StreamPart } from "effect/unstable/ai/Response"
import type * as Tool from "effect/unstable/ai/Tool"
import type * as Toolkit from "effect/unstable/ai/Toolkit"

import type { Json } from "../Event.ts"
import type { InstructionFragment } from "../Module.ts"

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

/** Canonicalize any runtime value into the journal's `Json` type. */
export const toJson = (value: unknown): Json =>
  /* SAFETY: stableJsonValue removes functions, symbols, undefined, and bigint. */
  stableJsonValue(value) as Json

const canonical = (value: unknown): string => JSON.stringify(stableJsonValue(value))

export interface ToolDescriptor {
  readonly name: string
  readonly description: string | undefined
  readonly parameters: string | undefined
}

/** The model-visible shape of each tool, sorted by name. */
export const toolDescriptors = (tools: ReadonlyArray<Tool.Any>): ReadonlyArray<ToolDescriptor> =>
  tools
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parametersSchema ? JSON.stringify(tool.parametersSchema) : undefined,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))

export const toolFingerprint = (tools: ReadonlyArray<ToolDescriptor>): string => canonical(tools)

export const planFingerprint = (
  instructions: ReadonlyArray<InstructionFragment>,
  tools: ReadonlyArray<ToolDescriptor>,
): string =>
  canonical({
    instructions: instructions.map((i) => ({ text: i.text, contributor: i.contributor })),
    tools,
  })

/**
 * The audit fingerprint of one logical model-facing request. Handlers and live
 * token deltas are intentionally not part of this value.
 */
export const requestFingerprint = (input: {
  readonly planFingerprint: string
  readonly promptFingerprint: string
  readonly toolNames: ReadonlyArray<string>
}): string =>
  canonical({
    plan: input.planFingerprint,
    prompt: input.promptFingerprint,
    toolNames: [...input.toolNames].sort(),
  })

export type ModelStream = Stream.Stream<StreamPart<Record<string, Tool.Any>>, AiError.AiError>

/** One physical model attempt over the erased registry toolkit. */
export const streamModel = (
  model: LanguageModel.Service,
  prompt: Prompt.Prompt,
  toolkit: Toolkit.WithHandler<Record<string, Tool.Any>>,
): ModelStream =>
  /* SAFETY: the registry validated these tools; the provider's decoded stream
   * error stays AiError and handler services were installed at finalize. */
  model.streamText({ prompt, toolkit, concurrency: "unbounded" }) as ModelStream
