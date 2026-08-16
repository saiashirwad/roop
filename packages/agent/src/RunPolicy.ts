import { Duration, Schema } from "effect"

export interface RunPolicy {
  readonly maxTurns: number
  readonly maxStepsPerTurn: number
  readonly maxTotalSteps: number
  readonly toolConcurrency: number | "unbounded"
  readonly modelTimeout?: Duration.Duration | undefined
  readonly toolTimeout?: Duration.Duration | undefined
  readonly maxToolOutputBytes?: number | undefined
}

export const defaultRunPolicy: RunPolicy = {
  maxTurns: 50,
  maxStepsPerTurn: 20,
  maxTotalSteps: 100,
  toolConcurrency: 4,
}

export const RunPolicy = Schema.Struct({
  maxTurns: Schema.Finite,
  maxStepsPerTurn: Schema.Finite,
  maxTotalSteps: Schema.Finite,
  toolConcurrency: Schema.Union([Schema.Finite, Schema.Literal("unbounded")]),
  modelTimeout: Schema.optionalKey(Schema.Duration),
  toolTimeout: Schema.optionalKey(Schema.Duration),
  maxToolOutputBytes: Schema.optionalKey(Schema.Finite),
})

/**
 * Resolves effective RunPolicy, respecting legacy `maxTurns` (which historically capped total steps).
 */
export const resolveRunPolicy = (options?: {
  readonly maxTurns?: number | undefined
  readonly policy?: Partial<RunPolicy> | undefined
}): RunPolicy => {
  const policy = options?.policy
  const legacyMaxTurns = options?.maxTurns
  let resolved: RunPolicy = {
    maxTurns: policy?.maxTurns ?? defaultRunPolicy.maxTurns,
    maxStepsPerTurn: policy?.maxStepsPerTurn ?? defaultRunPolicy.maxStepsPerTurn,
    maxTotalSteps: policy?.maxTotalSteps ?? legacyMaxTurns ?? defaultRunPolicy.maxTotalSteps,
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
