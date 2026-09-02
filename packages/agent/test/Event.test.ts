import { assert, it } from "@effect/vitest"
import { Effect, Exit, Schema } from "effect"

import {
  addUsage,
  emptyUsage,
  EVENT_VERSION,
  JournalEvent,
  ModelRequestEvent,
} from "../src/Event.ts"
import { isLive, isTerminal, LiveEvent, RunEvent, TextDelta } from "../src/RunEvent.ts"

const request = {
  _tag: "model/request" as const,
  version: EVENT_VERSION,
  at: 1_700_000_000_000,
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

const delta = {
  _tag: "text/delta" as const,
  version: EVENT_VERSION,
  at: 1,
  runId: "run-1",
  step: 1,
  delta: "a",
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
      Schema.decodeUnknownEffect(JournalEvent)({ ...request, version: EVENT_VERSION + 1 }),
    )
    assert.ok(Exit.isFailure(exit))
  }),
)

it.effect("every journal event requires a timestamp", () =>
  Effect.gen(function* () {
    const { at: _at, ...unstamped } = request
    const exit = yield* Effect.exit(Schema.decodeUnknownEffect(JournalEvent)(unstamped))
    assert.ok(Exit.isFailure(exit))
  }),
)

it("live deltas are run events but not durable events", () => {
  assert.ok(Schema.is(RunEvent)(delta))
  assert.ok(Schema.is(LiveEvent)(delta))
  assert.ok(Schema.is(TextDelta)(delta))
  assert.ok(!Schema.is(JournalEvent)(delta))
  assert.ok(Schema.is(RunEvent)(request))
  assert.ok(!Schema.is(LiveEvent)(request))
  assert.ok(Schema.is(ModelRequestEvent)(request))
  assert.ok(isLive(delta))
  assert.ok(!isLive(request))
})

it.effect("subagent events nest run events recursively over JSON", () =>
  Effect.gen(function* () {
    const nested = {
      _tag: "subagent" as const,
      version: EVENT_VERSION,
      at: 2,
      name: "child",
      toolCallId: "call-1",
      event: {
        _tag: "subagent" as const,
        version: EVENT_VERSION,
        at: 2,
        name: "grandchild",
        event: delta,
      },
    }
    const json = yield* Schema.encodeEffect(Schema.fromJsonString(RunEvent))(nested)
    const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(RunEvent))(json)
    assert.deepStrictEqual(decoded, nested)
  }),
)

it("isTerminal accepts only completed and aborted top-level runs", () => {
  const run = (state: "started" | "completed" | "aborted" | "recovered") => ({
    _tag: "run" as const,
    version: EVENT_VERSION,
    at: 0,
    sessionId: "s",
    runId: "r",
    state,
  })
  assert.ok(isTerminal(run("completed")))
  assert.ok(isTerminal(run("aborted")))
  assert.ok(!isTerminal(run("started")))
  assert.ok(!isTerminal(run("recovered")))
  assert.ok(
    !isTerminal({
      _tag: "subagent",
      version: EVENT_VERSION,
      at: 0,
      name: "child",
      event: run("completed"),
    }),
  )
})

it("usage sums totals and keeps optional counts only when reported", () => {
  assert.deepStrictEqual(addUsage(emptyUsage, emptyUsage), emptyUsage)
  const summed = addUsage(
    { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 4 },
    { inputTokens: 1, outputTokens: 2, totalTokens: 3, reasoningTokens: 2 },
  )
  assert.deepStrictEqual(summed, {
    inputTokens: 11,
    outputTokens: 7,
    totalTokens: 18,
    cachedInputTokens: 4,
    reasoningTokens: 2,
  })
})
