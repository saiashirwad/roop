/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-escape-hatch-assertions, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-known-value-widening -- policy merging handles partial optional configuration fields safely. */

import { type Duration, Option, Schema } from "effect"

export interface RunPolicy {
  readonly maxTurns?: number | undefined
  readonly maxStepsPerTurn?: number | undefined
  readonly maxTotalSteps?: number | undefined
  readonly toolConcurrency?: number | "unbounded" | undefined
  readonly modelTimeout?: Duration.Duration | undefined
  readonly toolTimeout?: Duration.Duration | undefined
  readonly maxToolOutputBytes?: number | undefined
}

export interface ResolvedRunPolicy {
  readonly maxTurns: number
  readonly maxStepsPerTurn: number
  readonly maxTotalSteps: number
  readonly toolConcurrency: number | "unbounded"
  readonly modelTimeout: Option.Option<Duration.Duration>
  readonly toolTimeout: Option.Option<Duration.Duration>
  readonly maxToolOutputBytes: Option.Option<number>
}

export const defaultRunPolicy: ResolvedRunPolicy = {
  maxTurns: 50,
  maxStepsPerTurn: 20,
  maxTotalSteps: 100,
  toolConcurrency: 4,
  modelTimeout: Option.none(),
  toolTimeout: Option.none(),
  maxToolOutputBytes: Option.none(),
}

export const RunPolicy = Schema.Struct({
  maxTurns: Schema.optionalKey(Schema.Finite),
  maxStepsPerTurn: Schema.optionalKey(Schema.Finite),
  maxTotalSteps: Schema.optionalKey(Schema.Finite),
  toolConcurrency: Schema.optionalKey(Schema.Union([Schema.Finite, Schema.Literal("unbounded")])),
  modelTimeout: Schema.optionalKey(Schema.Duration),
  toolTimeout: Schema.optionalKey(Schema.Duration),
  maxToolOutputBytes: Schema.optionalKey(Schema.Finite),
})

/**
 * Merges a base policy with overrides. Defined fields in overrides take precedence.
 */
export const mergePolicy = (base?: RunPolicy, overrides?: RunPolicy): RunPolicy | undefined => {
  if (base === undefined) return overrides
  if (overrides === undefined) return base
  const result: {
    maxTurns?: number
    maxStepsPerTurn?: number
    maxTotalSteps?: number
    toolConcurrency?: number | "unbounded"
    modelTimeout?: Duration.Duration
    toolTimeout?: Duration.Duration
    maxToolOutputBytes?: number
  } = {}

  const maxTurns = overrides.maxTurns ?? base.maxTurns
  if (maxTurns !== undefined) result.maxTurns = maxTurns

  const maxStepsPerTurn = overrides.maxStepsPerTurn ?? base.maxStepsPerTurn
  if (maxStepsPerTurn !== undefined) result.maxStepsPerTurn = maxStepsPerTurn

  const maxTotalSteps = overrides.maxTotalSteps ?? base.maxTotalSteps
  if (maxTotalSteps !== undefined) result.maxTotalSteps = maxTotalSteps

  const toolConcurrency = overrides.toolConcurrency ?? base.toolConcurrency
  if (toolConcurrency !== undefined) result.toolConcurrency = toolConcurrency

  const modelTimeout = overrides.modelTimeout ?? base.modelTimeout
  if (modelTimeout !== undefined) result.modelTimeout = modelTimeout

  const toolTimeout = overrides.toolTimeout ?? base.toolTimeout
  if (toolTimeout !== undefined) result.toolTimeout = toolTimeout

  const maxToolOutputBytes = overrides.maxToolOutputBytes ?? base.maxToolOutputBytes
  if (maxToolOutputBytes !== undefined) result.maxToolOutputBytes = maxToolOutputBytes

  return result
}

/**
 * Resolves effective RunPolicy against default values.
 */
export const resolveRunPolicy = (policy?: RunPolicy): ResolvedRunPolicy => ({
  maxTurns: policy?.maxTurns ?? defaultRunPolicy.maxTurns,
  maxStepsPerTurn: policy?.maxStepsPerTurn ?? defaultRunPolicy.maxStepsPerTurn,
  maxTotalSteps: policy?.maxTotalSteps ?? defaultRunPolicy.maxTotalSteps,
  toolConcurrency: policy?.toolConcurrency ?? defaultRunPolicy.toolConcurrency,
  modelTimeout: Option.fromNullishOr(policy?.modelTimeout),
  toolTimeout: Option.fromNullishOr(policy?.toolTimeout),
  maxToolOutputBytes: Option.fromNullishOr(policy?.maxToolOutputBytes),
})
