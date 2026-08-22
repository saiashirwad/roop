import { assert, it } from "@effect/vitest"
import { Effect, Schema } from "effect"

import { cryptoWeb } from "../src/cryptoWeb.ts"
import { ModelId, PluginId, SessionId } from "../src/DomainIds.ts"

it.effect("SessionId: creates, brands, validates, and generates", () =>
  Effect.gen(function* () {
    const id = SessionId.make("session-123")
    assert.strictEqual(id, "session-123")
    assert.strictEqual(SessionId.is(id), true)
    assert.strictEqual(SessionId.is(123), false)

    const decoded = yield* Schema.decodeEffect(SessionId)("session-456")
    assert.strictEqual(decoded, "session-456")
    assert.strictEqual(SessionId.is(decoded), true)

    const generated = yield* SessionId.generate
    assert.strictEqual(typeof generated, "string")
    assert.strictEqual(SessionId.is(generated), true)
    assert.strictEqual(generated.length > 0, true)
  }).pipe(Effect.provide(cryptoWeb)),
)

it.effect("ModelId: creates, brands, and validates", () =>
  Effect.gen(function* () {
    const id = ModelId.make("claude-3-5-sonnet")
    assert.strictEqual(id, "claude-3-5-sonnet")
    assert.strictEqual(ModelId.is(id), true)
    assert.strictEqual(ModelId.is(42), false)

    const decoded = yield* Schema.decodeEffect(ModelId)("gpt-4o")
    assert.strictEqual(decoded, "gpt-4o")
    assert.strictEqual(ModelId.is(decoded), true)
  }),
)

it.effect("PluginId: creates, brands, and validates", () =>
  Effect.gen(function* () {
    const id = PluginId.make("coding-tools")
    assert.strictEqual(id, "coding-tools")
    assert.strictEqual(PluginId.is(id), true)
    assert.strictEqual(PluginId.is(false), false)

    const decoded = yield* Schema.decodeEffect(PluginId)("todo")
    assert.strictEqual(decoded, "todo")
    assert.strictEqual(PluginId.is(decoded), true)
  }),
)
