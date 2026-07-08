import { assert, it } from "@effect/vitest"
import { Effect } from "effect"

import { promptFromSessionRecords } from "../src/sessionHistory.ts"
import type { SessionRecord } from "../src/SessionStore.ts"

const record = (
  entry: SessionRecord["entry"],
  overrides?: Partial<Pick<SessionRecord, "id" | "sessionId" | "createdAt">>,
): SessionRecord => ({
  id: overrides?.id ?? crypto.randomUUID(),
  sessionId: overrides?.sessionId ?? "session-1",
  createdAt: overrides?.createdAt ?? 1,
  entry,
})

it.effect("rebuilds user and assistant turns from session records", () =>
  Effect.sync(() => {
    const records: Array<SessionRecord> = [
      record({ _tag: "UserPrompt", prompt: "hi" }),
      record({
        _tag: "Agent",
        event: { _tag: "RunStarted", runId: "r1", sessionId: "session-1" },
      }),
      record({ _tag: "Agent", event: { _tag: "TextDelta", delta: "Hello" } }),
      record({ _tag: "Agent", event: { _tag: "TextDelta", delta: " world" } }),
      record({ _tag: "Agent", event: { _tag: "RunCompleted" } }),
      record({ _tag: "UserPrompt", prompt: "again" }),
      record({ _tag: "Agent", event: { _tag: "TextDelta", delta: "Sure" } }),
      record({ _tag: "Agent", event: { _tag: "RunCompleted" } }),
    ]

    const prompt = promptFromSessionRecords(records, "You are a coding assistant.")
    const roles = prompt.content.map((message) => message.role)

    assert.deepStrictEqual(roles, ["system", "user", "assistant", "user", "assistant"])

    const texts = prompt.content.flatMap((message) => {
      if (message.role === "system") {
        return [message.content]
      }
      if (message.role === "user" || message.role === "assistant") {
        return message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
      }
      return []
    })

    assert.ok(texts.some((text) => text.includes("coding assistant")))
    assert.ok(texts.includes("hi"))
    assert.ok(texts.includes("Hello world"))
    assert.ok(texts.includes("again"))
    assert.ok(texts.includes("Sure"))
  }),
)

it.effect("rebuilds tool call and tool result pairs", () =>
  Effect.sync(() => {
    const records: Array<SessionRecord> = [
      record({ _tag: "UserPrompt", prompt: "read package.json" }),
      record({
        _tag: "Agent",
        event: {
          _tag: "ToolCall",
          id: "call_1",
          name: "readFile",
          params: { path: "package.json" },
        },
      }),
      record({
        _tag: "Agent",
        event: {
          _tag: "ToolResult",
          id: "call_1",
          name: "readFile",
          isFailure: false,
          result: { path: "package.json", content: "{}" },
        },
      }),
      record({ _tag: "Agent", event: { _tag: "TextDelta", delta: "done" } }),
      record({ _tag: "Agent", event: { _tag: "RunCompleted" } }),
    ]

    const prompt = promptFromSessionRecords(records, "system")
    const roles = prompt.content.map((message) => message.role)

    assert.deepStrictEqual(roles, ["system", "user", "assistant", "tool", "assistant"])

    const assistant = prompt.content.find((message) => message.role === "assistant")
    assert.ok(assistant !== undefined && assistant.role === "assistant")
    const toolCall = assistant.content.find((part) => part.type === "tool-call")
    assert.ok(toolCall !== undefined && toolCall.type === "tool-call")
    assert.strictEqual(toolCall.id, "call_1")
    assert.strictEqual(toolCall.name, "readFile")

    const toolMessage = prompt.content.find((message) => message.role === "tool")
    assert.ok(toolMessage !== undefined && toolMessage.role === "tool")
    const toolResult = toolMessage.content[0]
    assert.ok(toolResult !== undefined && toolResult.type === "tool-result")
    assert.strictEqual(toolResult.id, "call_1")
    assert.deepStrictEqual(toolResult.result, { path: "package.json", content: "{}" })

    const finalAssistant = prompt.content.filter((m) => m.role === "assistant").at(-1)
    assert.ok(finalAssistant !== undefined && finalAssistant.role === "assistant")
    const text = finalAssistant.content.find((part) => part.type === "text")
    assert.ok(text !== undefined && text.type === "text")
    assert.strictEqual(text.text, "done")
  }),
)

it.effect("keeps multi-round tools then text in Chat Completions order", () =>
  Effect.sync(() => {
    const records: Array<SessionRecord> = [
      record({ _tag: "UserPrompt", prompt: "explore" }),
      record({
        _tag: "Agent",
        event: { _tag: "ToolCall", id: "c1", name: "listFiles", params: { path: "." } },
      }),
      record({
        _tag: "Agent",
        event: { _tag: "ToolCall", id: "c2", name: "gitStatus", params: {} },
      }),
      record({
        _tag: "Agent",
        event: {
          _tag: "ToolResult",
          id: "c1",
          name: "listFiles",
          isFailure: false,
          result: { entries: ["a"] },
        },
      }),
      record({
        _tag: "Agent",
        event: {
          _tag: "ToolResult",
          id: "c2",
          name: "gitStatus",
          isFailure: false,
          result: { clean: true },
        },
      }),
      record({
        _tag: "Agent",
        event: { _tag: "ToolCall", id: "c3", name: "readFile", params: { path: "a" } },
      }),
      record({
        _tag: "Agent",
        event: {
          _tag: "ToolResult",
          id: "c3",
          name: "readFile",
          isFailure: false,
          result: { content: "x" },
        },
      }),
      record({ _tag: "Agent", event: { _tag: "TextDelta", delta: "summary" } }),
      record({ _tag: "Agent", event: { _tag: "RunCompleted" } }),
    ]

    const prompt = promptFromSessionRecords(records, "system")
    const roles = prompt.content.map((message) => message.role)

    assert.deepStrictEqual(roles, [
      "system",
      "user",
      "assistant",
      "tool",
      "assistant",
      "tool",
      "assistant",
    ])

    for (let i = 0; i < prompt.content.length; i++) {
      const message = prompt.content[i]!
      if (message.role !== "assistant") continue
      const hasToolCall = message.content.some((part) => part.type === "tool-call")
      if (!hasToolCall) continue
      assert.strictEqual(prompt.content[i + 1]?.role, "tool")
    }

    const last = prompt.content.at(-1)
    assert.ok(last !== undefined && last.role === "assistant")
    const text = last.content.find((part) => part.type === "text")
    assert.ok(text !== undefined && text.type === "text")
    assert.strictEqual(text.text, "summary")
  }),
)

it.effect("empty session is system-only", () =>
  Effect.sync(() => {
    const prompt = promptFromSessionRecords([], "system only")
    assert.strictEqual(prompt.content.length, 1)
    assert.strictEqual(prompt.content[0]?.role, "system")
  }),
)

it.effect("closes incomplete tools with synthetic failures", () =>
  Effect.sync(() => {
    const records: Array<SessionRecord> = [
      record({ _tag: "UserPrompt", prompt: "interrupted mid-tool" }),
      record({
        _tag: "Agent",
        event: {
          _tag: "ToolCall",
          id: "call_open",
          name: "readFile",
          params: { path: "x" },
        },
      }),
      record({
        _tag: "Agent",
        event: { _tag: "RunInterrupted", runId: "run-1" },
      }),
    ]

    const prompt = promptFromSessionRecords(records, "system")
    const roles = prompt.content.map((message) => message.role)
    assert.deepStrictEqual(roles, ["system", "user", "assistant", "tool"])

    const toolMessage = prompt.content.find((message) => message.role === "tool")
    assert.ok(toolMessage !== undefined && toolMessage.role === "tool")
    const toolResult = toolMessage.content[0]
    assert.ok(toolResult !== undefined && toolResult.type === "tool-result")
    assert.strictEqual(toolResult.isFailure, true)
    assert.deepStrictEqual(toolResult.result, {
      message: "Tool result missing from session history",
    })
  }),
)

it.effect("skips subagent/progress/reasoning control-plane events", () =>
  Effect.sync(() => {
    const records: Array<SessionRecord> = [
      record({ _tag: "UserPrompt", prompt: "spawn then answer" }),
      record({
        _tag: "Agent",
        event: {
          _tag: "ToolCall",
          id: "spawn_1",
          name: "spawnAgent",
          params: { agent: "explore", task: "find x" },
        },
      }),
      record({
        _tag: "Agent",
        event: {
          _tag: "ToolProgress",
          id: "spawn_1",
          name: "spawnAgent",
          result: { status: "running", childSessionId: "c1" },
        },
      }),
      record({
        _tag: "Agent",
        event: {
          _tag: "SubagentStarted",
          parentToolCallId: "spawn_1",
          agentId: "explore",
          childSessionId: "c1",
          childRunId: "cr1",
        },
      }),
      record({
        _tag: "Agent",
        event: {
          _tag: "SubagentCompleted",
          parentToolCallId: "spawn_1",
          agentId: "explore",
          childSessionId: "c1",
          childRunId: "cr1",
          status: "completed",
        },
      }),
      record({
        _tag: "Agent",
        event: {
          _tag: "ToolResult",
          id: "spawn_1",
          name: "spawnAgent",
          isFailure: false,
          result: {
            status: "completed",
            summary: "found",
            childSessionId: "c1",
            childRunId: "cr1",
            agentId: "explore",
          },
        },
      }),
      record({
        _tag: "Agent",
        event: { _tag: "ReasoningDelta", delta: "thinking hard" },
      }),
      record({ _tag: "Agent", event: { _tag: "TextDelta", delta: "answer" } }),
      record({ _tag: "Agent", event: { _tag: "RunCompleted" } }),
    ]

    const prompt = promptFromSessionRecords(records, "system")
    const roles = prompt.content.map((message) => message.role)
    assert.deepStrictEqual(roles, ["system", "user", "assistant", "tool", "assistant"])

    const blob = JSON.stringify(prompt.content)
    assert.ok(!blob.includes("thinking hard"))
    assert.ok(!blob.includes("SubagentStarted"))
    assert.ok(!blob.includes("ToolProgress"))

    const last = prompt.content.at(-1)
    assert.ok(last !== undefined && last.role === "assistant")
    const text = last.content.find((part) => part.type === "text")
    assert.ok(text !== undefined && text.type === "text")
    assert.strictEqual(text.text, "answer")
  }),
)
