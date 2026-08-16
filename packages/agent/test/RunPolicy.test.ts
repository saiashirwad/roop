import { assert, it } from "@effect/vitest"
import { Duration, Effect, Schema } from "effect"

import { defaultRunPolicy, resolveRunPolicy, RunPolicy } from "../src/RunPolicy.ts"

it.effect("RunPolicy: default values are defined and sensible", () =>
  Effect.gen(function* () {
    assert.strictEqual(defaultRunPolicy.maxTurns, 50)
    assert.strictEqual(defaultRunPolicy.maxStepsPerTurn, 20)
    assert.strictEqual(defaultRunPolicy.maxTotalSteps, 100)
    assert.strictEqual(defaultRunPolicy.toolConcurrency, 4)
  }),
)

it.effect("RunPolicy: resolveRunPolicy resolves defaults when options omitted", () =>
  Effect.gen(function* () {
    const policy = resolveRunPolicy()
    assert.deepStrictEqual(policy, defaultRunPolicy)
  }),
)

it.effect("RunPolicy: resolveRunPolicy respects legacy maxTurns as maxTotalSteps", () =>
  Effect.gen(function* () {
    const policy = resolveRunPolicy({ maxTurns: 5 })
    assert.strictEqual(policy.maxTotalSteps, 5)
    assert.strictEqual(policy.maxTurns, 50)
  }),
)

it.effect("RunPolicy: resolveRunPolicy prioritizes explicit policy over legacy maxTurns", () =>
  Effect.gen(function* () {
    const policy = resolveRunPolicy({
      maxTurns: 5,
      policy: { maxTotalSteps: 10, maxTurns: 3, maxStepsPerTurn: 2, toolConcurrency: "unbounded" },
    })
    assert.strictEqual(policy.maxTotalSteps, 10)
    assert.strictEqual(policy.maxTurns, 3)
    assert.strictEqual(policy.maxStepsPerTurn, 2)
    assert.strictEqual(policy.toolConcurrency, "unbounded")
  }),
)

it.effect("RunPolicy: schema validates and decodes policy objects", () =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeEffect(RunPolicy)({
      maxTurns: 10,
      maxStepsPerTurn: 5,
      maxTotalSteps: 50,
      toolConcurrency: 8,
      modelTimeout: Duration.seconds(30),
    })
    assert.strictEqual(decoded.maxTurns, 10)
    assert.strictEqual(decoded.toolConcurrency, 8)
  }),
)
