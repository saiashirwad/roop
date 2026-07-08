import { assert, it } from "@effect/vitest"
import type { AgentEvent } from "@roop/core/AgentEvent.ts"
import type { SessionRecord } from "@roop/core/SessionStore.ts"
import { Effect } from "effect"

import { LAST_TEXT_MAX_LENGTH, scanSubagentRecords } from "../src/orchestrate.ts"

let counter = 0

const agentRecord = (event: AgentEvent): SessionRecord => ({
  id: `record-${counter++}`,
  sessionId: "session-1",
  createdAt: counter,
  entry: { _tag: "Agent", event },
})

const promptRecord = (prompt: string): SessionRecord => ({
  id: `record-${counter++}`,
  sessionId: "session-1",
  createdAt: counter,
  entry: { _tag: "UserPrompt", prompt },
})

it.effect("scanSubagentRecords reports running until a terminal event", () =>
  Effect.sync(() => {
    const started = [
      promptRecord("do the thing"),
      agentRecord({ _tag: "RunStarted", runId: "run-1", sessionId: "session-1" }),
      agentRecord({ _tag: "TextDelta", delta: "working" }),
    ]
    assert.strictEqual(scanSubagentRecords(started).running, true)

    const completed = [...started, agentRecord({ _tag: "RunCompleted" })]
    assert.strictEqual(scanSubagentRecords(completed).running, false)

    const resumed = [
      ...completed,
      agentRecord({ _tag: "RunStarted", runId: "run-2", sessionId: "session-1" }),
    ]
    assert.strictEqual(scanSubagentRecords(resumed).running, true)
  }),
)

it.effect("scanSubagentRecords keeps the last text block and counts agent events", () =>
  Effect.sync(() => {
    const records = [
      promptRecord("first"),
      agentRecord({ _tag: "RunStarted", runId: "run-1", sessionId: "session-1" }),
      agentRecord({ _tag: "TextDelta", delta: "first " }),
      agentRecord({ _tag: "TextDelta", delta: "answer" }),
      agentRecord({ _tag: "ToolCall", id: "call-1", name: "grep", params: {} }),
      agentRecord({ _tag: "TextDelta", delta: " final answer " }),
      agentRecord({ _tag: "RunCompleted" }),
    ]
    const activity = scanSubagentRecords(records)
    assert.strictEqual(activity.lastText, "final answer")
    assert.strictEqual(activity.eventCount, 6)
  }),
)

it.effect("scanSubagentRecords truncates long text and handles empty sessions", () =>
  Effect.sync(() => {
    const empty = scanSubagentRecords([])
    assert.deepStrictEqual(empty, { running: false, lastText: "", eventCount: 0 })

    const long = scanSubagentRecords([
      agentRecord({ _tag: "TextDelta", delta: "x".repeat(LAST_TEXT_MAX_LENGTH + 100) }),
    ])
    assert.strictEqual(long.lastText.length, LAST_TEXT_MAX_LENGTH + 1)
    assert.ok(long.lastText.endsWith("…"))
  }),
)
