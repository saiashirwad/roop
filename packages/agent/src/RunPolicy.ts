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

const defined = (policy: RunPolicy): RunPolicy =>
  Object.fromEntries(Object.entries(policy).filter(([, value]) => value !== undefined))

/** Merge two policies. Defined fields in `overrides` win. */
export const mergePolicy = (base?: RunPolicy, overrides?: RunPolicy): RunPolicy | undefined =>
  base === undefined
    ? overrides
    : overrides === undefined
      ? base
      : { ...defined(base), ...defined(overrides) }

/** Resolve a policy against the defaults. */
export const resolveRunPolicy = (policy: RunPolicy = {}): ResolvedRunPolicy => ({
  maxTurns: policy.maxTurns ?? defaultRunPolicy.maxTurns,
  maxStepsPerTurn: policy.maxStepsPerTurn ?? defaultRunPolicy.maxStepsPerTurn,
  maxTotalSteps: policy.maxTotalSteps ?? defaultRunPolicy.maxTotalSteps,
  toolConcurrency: policy.toolConcurrency ?? defaultRunPolicy.toolConcurrency,
  modelTimeout: Option.fromNullishOr(policy.modelTimeout),
  toolTimeout: Option.fromNullishOr(policy.toolTimeout),
  maxToolOutputBytes: Option.fromNullishOr(policy.maxToolOutputBytes),
})
