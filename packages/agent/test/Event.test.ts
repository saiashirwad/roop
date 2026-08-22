import { assert, it } from "@effect/vitest"
import { Effect, Exit, Schema } from "effect"

import {
  EVENT_VERSION,
  JournalEvent,
  LiveEvent,
  ModelRequestEvent,
  TextDelta,
} from "../src/Event.ts"

const request = {
  _tag: "model/request" as const,
  version: EVENT_VERSION,
  runId: "run-1",
  turn: 1,
  step: 1,
  requestId: "request-1",
  request: { prompt: "hello", toolChoice: "auto" },
  planFingerprint: "plan",
  promptFingerprint: "prompt",
  toolFingerprint: "tools",
  toolNames: ["lookup"],
}

it.effect("JournalEvent JSON round-trip preserves the effective request", () =>
  Effect.gen(function* () {
    const json = yield* Schema.encodeEffect(Schema.fromJsonString(JournalEvent))(request)
    const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(JournalEvent))(json)
    assert.deepStrictEqual(decoded, request)
  }),
)

it.effect("future event versions are rejected", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      /* SAFETY: This intentionally injects a future wire version at the decode boundary. */
      Schema.decodeUnknownEffect(JournalEvent)({ ...request, version: 2 }),
    )
    assert.ok(Exit.isFailure(exit))
  }),
)

it("live deltas are not durable events", () => {
  assert.ok(Schema.is(LiveEvent)({ _tag: "TextDelta", version: EVENT_VERSION, delta: "a" }))
  assert.ok(!Schema.is(JournalEvent)({ _tag: "TextDelta", version: EVENT_VERSION, delta: "a" }))
  assert.ok(Schema.is(ModelRequestEvent)(request))
  assert.ok(Schema.is(TextDelta)({ _tag: "TextDelta", version: EVENT_VERSION, delta: "a" }))
})
