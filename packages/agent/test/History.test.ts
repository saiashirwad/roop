import { assert, it } from "@effect/vitest"

import { EVENT_VERSION } from "../src/Event.ts"
import { fromEvents, recoveryEvents, toPrompt } from "../src/History.ts"

const started = {
  _tag: "run" as const,
  version: EVENT_VERSION,
  sessionId: "session",
  runId: "run",
  state: "started" as const,
}

it("projects complete messages and keeps tool call/result pairing", () => {
  const events = [
    { _tag: "user/message" as const, version: EVENT_VERSION, content: "find 42" },
    started,
    {
      _tag: "tool/call" as const,
      version: EVENT_VERSION,
      id: "call",
      name: "lookup",
      params: { id: "42" },
    },
    {
      _tag: "tool/result" as const,
      version: EVENT_VERSION,
      id: "call",
      name: "lookup",
      isFailure: false,
      result: { found: true },
    },
  ]
  const history = fromEvents(events)
  assert.deepStrictEqual(
    history.messages.map((message) => message.role),
    ["user", "assistant", "tool"],
  )
  assert.deepStrictEqual(toPrompt(events), toPrompt(history))
})

it("does not project an unresolved tool call before recovery", () => {
  const events = [
    { _tag: "user/message" as const, version: EVENT_VERSION, content: "run it" },
    {
      _tag: "tool/call" as const,
      version: EVENT_VERSION,
      id: "call",
      name: "dangerous",
      params: {},
    },
  ]
  assert.deepStrictEqual(
    fromEvents(events).messages.map((message) => message.role),
    ["user"],
  )
  const recovery = recoveryEvents(events)
  assert.strictEqual(recovery.length, 1)
  assert.strictEqual(recovery[0]?._tag, "tool/result")
  if (recovery[0]?._tag === "tool/result") {
    assert.deepStrictEqual(recovery[0].result, { type: "execution-unknown" })
  }
})

it("closes open run, turn, step, attempt, and tool spans in deterministic order", () => {
  const events = [
    started,
    {
      _tag: "turn" as const,
      version: EVENT_VERSION,
      runId: "run",
      turn: 1,
      state: "started" as const,
    },
    {
      _tag: "step" as const,
      version: EVENT_VERSION,
      runId: "run",
      turn: 1,
      step: 1,
      state: "started" as const,
    },
    {
      _tag: "model/attempt" as const,
      version: EVENT_VERSION,
      runId: "run",
      turn: 1,
      step: 1,
      attempt: 1,
      requestId: "request",
      state: "started" as const,
    },
    {
      _tag: "tool" as const,
      version: EVENT_VERSION,
      runId: "run",
      turn: 1,
      step: 1,
      id: "tool",
      name: "lookup",
      state: "started" as const,
    },
  ]
  assert.deepStrictEqual(
    recoveryEvents(events).map((event) => event._tag),
    ["tool", "model/attempt", "step", "turn", "run"],
  )
})

it("recovers a reused provider call id by run, turn, and step", () => {
  const events = [
    {
      _tag: "tool/call" as const,
      version: EVENT_VERSION,
      runId: "run",
      turn: 1,
      step: 1,
      id: "reused",
      name: "lookup",
      params: { id: "first" },
    },
    {
      _tag: "tool/result" as const,
      version: EVENT_VERSION,
      runId: "run",
      turn: 1,
      step: 1,
      id: "reused",
      name: "lookup",
      isFailure: false,
      result: "first",
    },
    {
      _tag: "tool/call" as const,
      version: EVENT_VERSION,
      runId: "run",
      turn: 1,
      step: 2,
      id: "reused",
      name: "lookup",
      params: { id: "second" },
    },
  ]

  const recovery = recoveryEvents(events)
  assert.strictEqual(recovery.length, 1)
  assert.strictEqual(recovery[0]?._tag, "tool/result")
  if (recovery[0]?._tag === "tool/result") {
    assert.strictEqual(recovery[0].step, 2)
    assert.deepStrictEqual(recovery[0].result, { type: "execution-unknown" })
  }
})
