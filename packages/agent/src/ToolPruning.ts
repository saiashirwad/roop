/* oxlint-disable anti-slop/no-conditional-empty-object-spread, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- Prompt tool-result payloads are schema-erased by effect/unstable/ai; pruning must measure their original encoded representation without imposing a portable-kernel dependency. */
import { Effect, type Layer, Predicate, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"

import { type AgentHooks, layerHook, type ModelRequest, type RunContext } from "./AgentHooks.ts"

/* ========================================================================== *
 * Schemas & Metadata                                                         *
 * ========================================================================== */

/** Metadata payload recorded when a historical tool result is pruned. */
export const PrunedToolResult = Schema.Struct({
  _pruned: Schema.Literal(true),
  toolName: Schema.String,
  callId: Schema.String,
  originalBytes: Schema.Finite,
  originalLines: Schema.optionalKey(Schema.Finite),
  summary: Schema.String,
  notice: Schema.String,
})
export type PrunedToolResult = typeof PrunedToolResult.Type

export interface PrunePolicy {
  /** Maximum byte size allowed for historical tool results before stubbing (default: 2048). */
  readonly maxResultBytes?: number | undefined
  /** Number of most recent tool results to preserve intact (default: 3). */
  readonly keepRecentResults?: number | undefined
  /** Whether to preserve failed tool results intact for debugging (default: false). */
  readonly preserveFailures?: boolean | undefined
}

/* ========================================================================== *
 * Pure Byte & Line Counting (Zero native/platform dependencies)              *
 * ========================================================================== */

const encoder = new TextEncoder()

const getByteLength = (val: unknown): number => {
  if (typeof val === "string") {
    return encoder.encode(val).byteLength
  }
  try {
    const json = JSON.stringify(val)
    return json === undefined ? 0 : encoder.encode(json).byteLength
  } catch {
    return 0
  }
}

const countLines = (val: unknown): number | undefined => {
  if (typeof val === "string") {
    return val.split("\n").length
  }
  if (Predicate.hasProperty(val, "stdout") && typeof val.stdout === "string") {
    return val.stdout.split("\n").length
  }
  if (Predicate.hasProperty(val, "content") && typeof val.content === "string") {
    return val.content.split("\n").length
  }
  return undefined
}

/* ========================================================================== *
 * Pure Prompt Message Rewriter                                               *
 * ========================================================================== */

/**
 * Pure prompt rewriter that inspects Prompt.Message sequences and stubs
 * historical large tool results while preserving all tool-call/result ID pairings.
 */
export const prunePromptMessages = (
  prompt: Prompt.Prompt,
  policy: {
    readonly maxResultBytes: number
    readonly keepRecentResults: number
    readonly preserveFailures: boolean
  },
): Prompt.Prompt => {
  const messages = prompt.content
  const lastToolMessageIndex = messages.reduce(
    (last, message, index) => (message.role === "tool" ? index : last),
    -1,
  )

  // 1. Identify total tool results across all messages to determine the retention window
  let totalToolResults = 0
  for (const msg of messages) {
    if (msg.role === "tool") {
      for (const part of msg.content) {
        if (part.type === "tool-result") {
          totalToolResults++
        }
      }
    }
  }

  const pruneThresholdIndex = Math.max(0, totalToolResults - policy.keepRecentResults)
  let currentResultIndex = 0

  const rewrittenMessages = messages.map((msg, messageIndex): Prompt.Message => {
    if (msg.role !== "tool") {
      return msg
    }

    const newParts = msg.content.map((part) => {
      if (part.type !== "tool-result") {
        return part
      }

      const isHistorical =
        currentResultIndex < pruneThresholdIndex && messageIndex !== lastToolMessageIndex
      currentResultIndex++

      if (!isHistorical) {
        return part
      }
      if (Predicate.hasProperty(part.result, "_pruned") && part.result._pruned === true) {
        return part
      }
      if (policy.preserveFailures && part.isFailure) {
        return part
      }

      const size = getByteLength(part.result)
      if (size <= policy.maxResultBytes) {
        return part
      }

      const lines = countLines(part.result)
      const stub: PrunedToolResult = {
        _pruned: true,
        toolName: part.name,
        callId: part.id,
        originalBytes: size,
        ...(lines === undefined ? undefined : { originalLines: lines }),
        summary: `Output pruned (${size} bytes${lines !== undefined ? `, ${lines} lines` : ""}).`,
        notice: `Historical tool output pruned to conserve context. Re-run '${part.name}' with specific parameters if needed.`,
      }

      return Prompt.makePart("tool-result", {
        id: part.id,
        name: part.name,
        isFailure: part.isFailure,
        result: stub,
      })
    })

    return Prompt.makeMessage("tool", { content: newParts })
  })

  return Prompt.fromMessages(rewrittenMessages)
}

/* ========================================================================== *
 * Layer: layerToolPruning                                                    *
 * ========================================================================== */

/**
 * Pure AgentHooks layer that stubs historical large tool-result payloads in
 * beforeRequest, preserving recent results and ID graph consistency.
 */
export const layerToolPruning = (
  options?: PrunePolicy,
): Layer.Layer<AgentHooks, never, AgentHooks> => {
  const maxResultBytes = Math.max(0, Math.floor(options?.maxResultBytes ?? 2048))
  const keepRecentResults = Math.max(0, Math.floor(options?.keepRecentResults ?? 3))
  const preserveFailures = options?.preserveFailures ?? false

  return layerHook("tool-pruning", (downstream) =>
    Effect.succeed({
      ...downstream,
      beforeRequest: (context: RunContext, request: ModelRequest) =>
        Effect.gen(function* () {
          const normalizedPrompt = Prompt.make(request.prompt)
          const prunedPrompt = prunePromptMessages(normalizedPrompt, {
            maxResultBytes,
            keepRecentResults,
            preserveFailures,
          })

          const updatedRequest: ModelRequest = {
            ...request,
            prompt: prunedPrompt,
          }

          return yield* downstream.beforeRequest(context, updatedRequest)
        }),
    }),
  )
}
