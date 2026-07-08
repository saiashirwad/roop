import { assert, it } from "@effect/vitest"
import { Effect } from "effect"

it.effect("runs an Effect", () =>
  Effect.gen(function* () {
    const value = yield* Effect.succeed(42)

    assert.strictEqual(value, 42)
  }),
)
