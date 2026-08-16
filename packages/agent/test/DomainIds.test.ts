import { assert, it } from "@effect/vitest"
import { Effect, Schema } from "effect"

import { cryptoWeb } from "../src/cryptoWeb.ts"
import * as EventId from "../src/EventId.ts"
import * as ModelId from "../src/ModelId.ts"
import * as PluginId from "../src/PluginId.ts"
import * as RunId from "../src/RunId.ts"
import * as SessionId from "../src/SessionId.ts"
import * as ToolCallId from "../src/ToolCallId.ts"

it.effect("SessionId: creates, brands, validates, and generates", () =>
  Effect.gen(function* () {
    const id = SessionId.make("session-123")
    assert.strictEqual(id, "session-123")
    assert.strictEqual(SessionId.is(id), true)
    assert.strictEqual(SessionId.is(123), false)

    const decoded = yield* Schema.decodeEffect(SessionId.SessionId)("session-456")
    assert.strictEqual(decoded, "session-456")
    assert.strictEqual(SessionId.is(decoded), true)

    const generated = yield* SessionId.generate
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
    assert.strictEqual(RunId.is(null), false)

    const decoded = yield* Schema.decodeEffect(RunId.RunId)("run-456")
    assert.strictEqual(decoded, "run-456")

    const generated = yield* RunId.generate
    assert.strictEqual(RunId.is(generated), true)
    assert.strictEqual(generated.length > 0, true)
  }).pipe(Effect.provide(cryptoWeb)),
)

it.effect("EventId: creates, brands, validates, and generates", () =>
  Effect.gen(function* () {
    const id = EventId.make("event-123")
    assert.strictEqual(id, "event-123")
    assert.strictEqual(EventId.is(id), true)

    const decoded = yield* Schema.decodeEffect(EventId.EventId)("event-456")
    assert.strictEqual(decoded, "event-456")

    const generated = yield* EventId.generate
    assert.strictEqual(EventId.is(generated), true)
  }).pipe(Effect.provide(cryptoWeb)),
)

it.effect("ModelId: creates, brands, and validates", () =>
  Effect.gen(function* () {
    const id = ModelId.make("claude-3-5-sonnet")
    assert.strictEqual(id, "claude-3-5-sonnet")
    assert.strictEqual(ModelId.is(id), true)
    assert.strictEqual(ModelId.is(42), false)

    const decoded = yield* Schema.decodeEffect(ModelId.ModelId)("gpt-4o")
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

    const decoded = yield* Schema.decodeEffect(PluginId.PluginId)("todo")
    assert.strictEqual(decoded, "todo")
    assert.strictEqual(PluginId.is(decoded), true)
  }),
)

it.effect("ToolCallId: creates, brands, validates, and generates", () =>
  Effect.gen(function* () {
    const id = ToolCallId.make("call-123")
    assert.strictEqual(id, "call-123")
    assert.strictEqual(ToolCallId.is(id), true)

    const decoded = yield* Schema.decodeEffect(ToolCallId.ToolCallId)("call-456")
    assert.strictEqual(decoded, "call-456")

    const generated = yield* ToolCallId.generate
    assert.strictEqual(ToolCallId.is(generated), true)
  }).pipe(Effect.provide(cryptoWeb)),
)
