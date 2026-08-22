import { assert, it } from "@effect/vitest"
import { Effect, Schema } from "effect"

import { cryptoWeb } from "../src/cryptoWeb.ts"
import { RunId, SessionId } from "../src/DomainIds.ts"

it.effect("SessionId: creates, brands, validates, and generates", () =>
  Effect.gen(function* () {
    const id = SessionId.make("session-123")
    assert.strictEqual(id, "session-123")
    assert.strictEqual(SessionId.is(id), true)
    assert.strictEqual(SessionId.is(123), false)

    const decoded = yield* Schema.decodeEffect(SessionId)("session-456")
    assert.strictEqual(decoded, "session-456")
    assert.strictEqual(SessionId.is(decoded), true)

    const generated = yield* SessionId.generate()
    assert.strictEqual(typeof generated, "string")
    assert.strictEqual(SessionId.is(generated), true)
    assert.strictEqual(generated.length > 0, true)
  }).pipe(Effect.provide(cryptoWeb)),
)

it.effect("RunId: creates, brands, validates, and generates", () =>
  Effect.gen(function* () {
    const id = RunId.make("run-123")
    assert.strictEqual(id, "run-123")
    assert.strictEqual(RunId.is(id), true)
    assert.strictEqual(RunId.is(123), false)

    const decoded = yield* Schema.decodeEffect(RunId)("run-456")
    assert.strictEqual(decoded, "run-456")
    assert.strictEqual(RunId.is(decoded), true)

    const generated = yield* RunId.generate()
    assert.strictEqual(typeof generated, "string")
    assert.strictEqual(RunId.is(generated), true)
    assert.strictEqual(generated.length > 0, true)
  }).pipe(Effect.provide(cryptoWeb)),
)
