import { Duration, Schema } from "effect"

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
  readonly modelTimeout?: Duration.Duration | undefined
  readonly toolTimeout?: Duration.Duration | undefined
  readonly maxToolOutputBytes?: number | undefined
}

export const defaultRunPolicy: ResolvedRunPolicy = {
  maxTurns: 50,
  maxStepsPerTurn: 20,
  maxTotalSteps: 100,
  toolConcurrency: 4,
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
 * Resolves effective RunPolicy against default values.
 */
export const resolveRunPolicy = (policy?: RunPolicy): ResolvedRunPolicy => {
  let resolved: ResolvedRunPolicy = {
    maxTurns: policy?.maxTurns ?? defaultRunPolicy.maxTurns,
    maxStepsPerTurn: policy?.maxStepsPerTurn ?? defaultRunPolicy.maxStepsPerTurn,
    maxTotalSteps: policy?.maxTotalSteps ?? defaultRunPolicy.maxTotalSteps,
    toolConcurrency: policy?.toolConcurrency ?? defaultRunPolicy.toolConcurrency,
  }
  if (policy?.modelTimeout !== undefined) {
    resolved = { ...resolved, modelTimeout: policy.modelTimeout }
  }
  if (policy?.toolTimeout !== undefined) {
    resolved = { ...resolved, toolTimeout: policy.toolTimeout }
  }
  if (policy?.maxToolOutputBytes !== undefined) {
    resolved = { ...resolved, maxToolOutputBytes: policy.maxToolOutputBytes }
  }
  return resolved
}
