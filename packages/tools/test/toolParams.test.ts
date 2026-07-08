import { assert, it } from "@effect/vitest"
import { Effect, Schema } from "effect"

import { isTrue, llmOptional, nonEmptyString } from "../src/params.ts"

const Params = Schema.Struct({
  cwd: llmOptional(Schema.String),
  staged: llmOptional(Schema.Boolean),
})

it.effect("llmOptional accepts missing, null, and real values", () =>
  Effect.gen(function* () {
    const missing = yield* Schema.decodeUnknownEffect(Params)({})
    assert.deepStrictEqual(missing, {})

    const withNull = yield* Schema.decodeUnknownEffect(Params)({ cwd: null, staged: null })
    assert.strictEqual(withNull.cwd, null)
    assert.strictEqual(withNull.staged, null)

    const withValues = yield* Schema.decodeUnknownEffect(Params)({
      cwd: "src",
      staged: true,
    })
    assert.strictEqual(withValues.cwd, "src")
    assert.strictEqual(withValues.staged, true)
  }),
)

it.effect("nonEmptyString and isTrue normalize model nulls", () =>
  Effect.sync(() => {
    assert.strictEqual(nonEmptyString(null), undefined)
    assert.strictEqual(nonEmptyString(undefined), undefined)
    assert.strictEqual(nonEmptyString(""), undefined)
    assert.strictEqual(nonEmptyString("src"), "src")
    assert.strictEqual(isTrue(null), false)
    assert.strictEqual(isTrue(undefined), false)
    assert.strictEqual(isTrue(false), false)
    assert.strictEqual(isTrue(true), true)
  }),
)
