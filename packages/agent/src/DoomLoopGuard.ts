/* oxlint-disable anti-slop/no-known-value-widening, anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns, anti-slop/no-unsafe-dictionary-type, anti-slop/require-safety-comment-for-type-assertion -- Tool.Any parameters cross Effect AI's schema-erased boundary; this canonicalizer intentionally accepts that representation without adding a runtime dependency to the portable kernel. */
import { Effect, type Layer, Ref } from "effect"

import {
  type AgentHooks,
  layerHook,
  type RunContext,
  type ToolCallInfo,
  ToolRejected,
} from "./AgentHooks.ts"

/* ========================================================================== *
 * Pure Canonicalization Homomorphism                                         *
 * ========================================================================== */

/**
 * JSON.stringify-compatible normalisation with recursively sorted object keys.
 * Tool parameters are JSON values after schema decoding, but keeping this
 * defensive makes a guard rejection preferable to an unexpected defect should
 * a custom tool hand us an unusual value.
 */
const canonicalize = (value: unknown): string => {
  const activePath = new Set<object>()

  const normalize = (current: unknown, inArray = false): unknown => {
    if (current === null) return null
    switch (typeof current) {
      case "string":
      case "boolean":
        return current
      case "number":
        return Number.isFinite(current) ? current : null
      case "bigint":
        return `bigint:${current}`
      case "undefined":
      case "function":
      case "symbol":
        return inArray ? null : undefined
      case "object": {
        if (activePath.has(current)) return "[circular]"
        activePath.add(current)
        try {
          if (Array.isArray(current)) return current.map((item) => normalize(item, true))

          const result: Record<string, unknown> = {}
          for (const key of Object.keys(current as Record<string, unknown>).sort()) {
            const normalized = normalize((current as Record<string, unknown>)[key])
            if (normalized !== undefined) result[key] = normalized
          }
          return result
        } finally {
          activePath.delete(current)
        }
      }
      default:
        return "[unsupported]"
    }
  }

  return JSON.stringify(normalize(value)) ?? "null"
}

/* ========================================================================== *
 * Periodicity Cycle Verification                                             *
 * ========================================================================== */

const isPeriodicSuffix = (
  fingerprints: ReadonlyArray<string>,
  cycleLength: number,
  repetitions: number,
): boolean => {
  const windowSize = cycleLength * repetitions
  if (fingerprints.length < windowSize) {
    return false
  }

  const slice = fingerprints.slice(-windowSize)
  // Ensure candidate cycle is not degenerate (period < cycleLength, e.g. all identical)
  const isDegenerate =
    cycleLength === 2 ? slice[0] === slice[1] : slice[0] === slice[1] && slice[1] === slice[2]
  if (isDegenerate) {
    return false
  }
  for (let i = 0; i < windowSize; i++) {
    if (slice[i] !== slice[i % cycleLength]) {
      return false
    }
  }
  return true
}

type Decision =
  | { readonly _tag: "Admitted" }
  | { readonly _tag: "Rejected"; readonly reason: string }

/* ========================================================================== *
 * Policy & Hook Layer: layerDoomLoopGuard                                     *
 * ========================================================================== */

export interface DoomLoopPolicy {
  /** Maximum identical consecutive tool calls before rejection (default: 3). */
  readonly maxConsecutiveIdenticalCalls?: number | undefined
  /** Maximum cycle repetitions (e.g. A->B->A->B->A->B, default: 3). */
  readonly maxCycleRepetitions?: number | undefined
  /** Window size of call history to analyze (default: 12). */
  readonly historyCapacity?: number | undefined
}

/**
 * Pure AgentHooks layer that intercepts runaway repeating tool streaks and
 * periodic alternating cycles, converting them into constructive rejections.
 */
export const layerDoomLoopGuard = (
  policy?: DoomLoopPolicy,
): Layer.Layer<AgentHooks, never, AgentHooks> => {
  const maxIdentical = Math.max(1, Math.floor(policy?.maxConsecutiveIdenticalCalls ?? 3))
  const maxCycleReps = Math.max(2, Math.floor(policy?.maxCycleRepetitions ?? 3))
  const capacity = Math.max(
    maxIdentical - 1,
    maxCycleReps * 3,
    Math.floor(policy?.historyCapacity ?? 12),
  )

  return layerHook("doom-loop-guard", (downstream) =>
    Effect.gen(function* () {
      // Hooks are installed once for a live agent, while an agent can service
      // many independent sessions. Never let one user's call history deny a
      // different user's tool call.
      const historyRef = yield* Ref.make<Map<string, ReadonlyArray<string>>>(new Map())

      return {
        ...downstream,

        beforeToolExecute: (context: RunContext, call: ToolCallInfo) =>
          Effect.gen(function* () {
            const currentFingerprint = `${call.name}:${canonicalize(call.params)}`

            const decide = (
              histories: Map<string, ReadonlyArray<string>>,
            ): readonly [Decision, Map<string, ReadonlyArray<string>>] => {
              const history = histories.get(context.sessionId) ?? []

              // 1. Streak Test: Count consecutive identical calls.
              let streak = 0
              for (let i = history.length - 1; i >= 0; i--) {
                if (history[i] === currentFingerprint) streak++
                else break
              }

              if (streak + 1 >= maxIdentical) {
                return [
                  {
                    _tag: "Rejected",
                    reason:
                      `Doom loop detected: Tool '${call.name}' called with identical arguments ` +
                      `${streak + 1} times consecutively without progress. Execution denied. ` +
                      `Please inspect prior outputs, analyze what failed, and pursue an alternative strategy.`,
                  },
                  histories,
                ] as const
              }

              // 2. Cycle Test: A->B->A->B and A->B->C->A->B->C.
              const fullHistory = [...history, currentFingerprint]
              for (const cycleLength of [2, 3]) {
                if (isPeriodicSuffix(fullHistory, cycleLength, maxCycleReps)) {
                  return [
                    {
                      _tag: "Rejected",
                      reason:
                        `Doom cycle detected: A repeating sequence of ${cycleLength} alternating tool calls was executed ` +
                        `${maxCycleReps} times without progress. Execution halted. ` +
                        `Please review your strategy and pursue a different course of action.`,
                    },
                    histories,
                  ] as const
                }
              }

              const nextHistories = new Map(histories)
              nextHistories.set(context.sessionId, fullHistory.slice(-capacity))
              return [{ _tag: "Admitted" }, nextHistories] as const
            }

            const decision = yield* Ref.modify(historyRef, decide)

            if (decision._tag === "Rejected") {
              return yield* new ToolRejected({ reason: decision.reason })
            }

            return yield* downstream.beforeToolExecute(context, call)
          }),
      }
    }),
  )
}
