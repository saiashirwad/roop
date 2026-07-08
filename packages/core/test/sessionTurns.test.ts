import { assert, it } from "@effect/vitest"
import { Effect } from "effect"

import type { SessionRecord } from "../src/SessionStore.ts"
import type { Turn } from "../src/sessionTurns.ts"
import { applyEvent, applyRecord, turnsFromRecords } from "../src/sessionTurns.ts"

const emptyAssistant = (): Turn => ({
  id: "a1",
  role: "assistant",
  blocks: [],
})

it.effect("merges tool call with tool result by id", () =>
  Effect.sync(() => {
    let turn = emptyAssistant()
    turn = applyEvent(turn, {
      _tag: "ToolCall",
      id: "call_1",
      name: "readFile",
      params: { path: "package.json" },
    })
    turn = applyEvent(turn, {
      _tag: "ToolResult",
      id: "call_1",
      name: "readFile",
      isFailure: false,
      result: { content: "{}" },
    })

    assert.strictEqual(turn.blocks.length, 1)
    const tool = turn.blocks[0]
    assert.ok(tool?.kind === "tool")
    if (tool?.kind === "tool") {
      assert.strictEqual(tool.status, "done")
      assert.strictEqual(tool.isFailure, false)
      assert.deepStrictEqual(tool.result, { content: "{}" })
    }
  }),
)

it.effect("links spawnAgent progress and subagent lifecycle to tool block", () =>
  Effect.sync(() => {
    let turn = emptyAssistant()
    turn = applyEvent(turn, {
      _tag: "ToolCall",
      id: "call_spawn",
      name: "spawnAgent",
      params: { agent: "explore", task: "find SessionLog" },
    })
    turn = applyEvent(turn, {
      _tag: "ToolProgress",
      id: "call_spawn",
      name: "spawnAgent",
      result: {
        status: "running",
        childSessionId: "child-1",
        childRunId: "run-child",
        agentId: "explore",
        summary: "Subagent started",
      },
    })

    let tool = turn.blocks[0]
    assert.ok(tool?.kind === "tool")
    if (tool?.kind === "tool") {
      assert.strictEqual(tool.subagent?.childSessionId, "child-1")
      assert.strictEqual(tool.subagent?.status, "running")
      assert.strictEqual(tool.subagent?.agentId, "explore")
    }

    turn = applyEvent(turn, {
      _tag: "SubagentCompleted",
      parentToolCallId: "other-id",
      agentId: "explore",
      childSessionId: "child-1",
      childRunId: "run-child",
      status: "completed",
    })
    tool = turn.blocks[0]
    assert.ok(tool?.kind === "tool")
    if (tool?.kind === "tool") {
      assert.strictEqual(tool.subagent?.status, "completed")
    }

    turn = applyEvent(turn, {
      _tag: "ToolResult",
      id: "call_spawn",
      name: "spawnAgent",
      isFailure: false,
      result: {
        status: "completed",
        summary: "found it",
        childSessionId: "child-1",
        childRunId: "run-child",
        agentId: "explore",
      },
    })
    tool = turn.blocks[0]
    assert.ok(tool?.kind === "tool")
    if (tool?.kind === "tool") {
      assert.strictEqual(tool.status, "done")
      assert.strictEqual(tool.subagent?.status, "completed")
    }
  }),
)

it.effect("links a differently-named spawn-like tool by matching parentToolCallId", () =>
  Effect.sync(() => {
    let turn = emptyAssistant()
    turn = applyEvent(turn, {
      _tag: "ToolCall",
      id: "call_delegate",
      name: "delegate",
      params: { agent: "researcher", task: "dig" },
    })

    turn = applyEvent(turn, {
      _tag: "SubagentStarted",
      parentToolCallId: "call_delegate",
      agentId: "researcher",
      childSessionId: "child-9",
      childRunId: "run-9",
    })

    let tool = turn.blocks[0]
    assert.ok(tool?.kind === "tool")
    if (tool?.kind === "tool") {
      assert.strictEqual(tool.name, "delegate")
      assert.strictEqual(tool.subagent?.childSessionId, "child-9")
      assert.strictEqual(tool.subagent?.agentId, "researcher")
      assert.strictEqual(tool.subagent?.childRunId, "run-9")
      assert.strictEqual(tool.subagent?.status, "running")
    }

    turn = applyEvent(turn, {
      _tag: "SubagentCompleted",
      parentToolCallId: "call_delegate",
      agentId: "researcher",
      childSessionId: "child-9",
      childRunId: "run-9",
      status: "completed",
    })
    tool = turn.blocks[0]
    assert.ok(tool?.kind === "tool")
    if (tool?.kind === "tool") {
      assert.strictEqual(tool.subagent?.status, "completed")
    }
  }),
)

it.effect("links a spawn-like tool by child session when parentToolCallId does not match", () =>
  Effect.sync(() => {
    let turn = emptyAssistant()
    turn = applyEvent(turn, {
      _tag: "ToolCall",
      id: "call_delegate",
      name: "delegate",
      params: {},
    })
    turn = applyEvent(turn, {
      _tag: "ToolProgress",
      id: "call_delegate",
      name: "delegate",
      result: {
        status: "running",
        childSessionId: "child-7",
        childRunId: "run-7",
        agentId: "researcher",
        summary: "Subagent started",
      },
    })
    turn = applyEvent(turn, {
      _tag: "SubagentCompleted",
      parentToolCallId: "minted-uuid",
      agentId: "researcher",
      childSessionId: "child-7",
      childRunId: "run-7",
      status: "failed",
    })
    const tool = turn.blocks[0]
    assert.ok(tool?.kind === "tool")
    if (tool?.kind === "tool") {
      assert.strictEqual(tool.name, "delegate")
      assert.strictEqual(tool.subagent?.childSessionId, "child-7")
      assert.strictEqual(tool.subagent?.status, "failed")
    }
  }),
)

it.effect("turnsFromRecords rebuilds user + assistant with tools", () =>
  Effect.sync(() => {
    const records: Array<SessionRecord> = [
      {
        id: "r1",
        sessionId: "s1",
        createdAt: 1,
        entry: { _tag: "UserPrompt", prompt: "read package.json" },
      },
      {
        id: "r2",
        sessionId: "s1",
        createdAt: 2,
        entry: {
          _tag: "Agent",
          event: { _tag: "RunStarted", runId: "run-1", sessionId: "s1" },
        },
      },
      {
        id: "r3",
        sessionId: "s1",
        createdAt: 3,
        entry: {
          _tag: "Agent",
          event: {
            _tag: "ToolCall",
            id: "call_1",
            name: "readFile",
            params: { path: "package.json" },
          },
        },
      },
      {
        id: "r4",
        sessionId: "s1",
        createdAt: 4,
        entry: {
          _tag: "Agent",
          event: {
            _tag: "ToolResult",
            id: "call_1",
            name: "readFile",
            isFailure: false,
            result: { path: "package.json", content: "{}" },
          },
        },
      },
      {
        id: "r5",
        sessionId: "s1",
        createdAt: 5,
        entry: { _tag: "Agent", event: { _tag: "TextDelta", delta: "done" } },
      },
      {
        id: "r6",
        sessionId: "s1",
        createdAt: 6,
        entry: { _tag: "Agent", event: { _tag: "RunCompleted" } },
      },
    ]

    const turns = turnsFromRecords(records)
    assert.strictEqual(turns.length, 2)
    assert.strictEqual(turns[0]?.role, "user")
    assert.strictEqual(turns[1]?.role, "assistant")
    assert.ok(turns[1]?.blocks.some((b) => b.kind === "tool"))
    assert.ok(turns[1]?.blocks.some((b) => b.kind === "text" && b.text === "done"))
  }),
)

it.effect("applyRecord matches turnsFromRecords incrementally", () =>
  Effect.sync(() => {
    const records: Array<SessionRecord> = [
      {
        id: "r1",
        sessionId: "s1",
        createdAt: 1,
        entry: { _tag: "UserPrompt", prompt: "hi" },
      },
      {
        id: "r2",
        sessionId: "s1",
        createdAt: 2,
        entry: {
          _tag: "Agent",
          event: { _tag: "RunStarted", runId: "run-1", sessionId: "s1" },
        },
      },
      {
        id: "r3",
        sessionId: "s1",
        createdAt: 3,
        entry: { _tag: "Agent", event: { _tag: "TextDelta", delta: "hello" } },
      },
      {
        id: "r4",
        sessionId: "s1",
        createdAt: 4,
        entry: { _tag: "Agent", event: { _tag: "RunCompleted" } },
      },
    ]

    let turns: ReadonlyArray<Turn> = []
    for (const record of records) {
      turns = applyRecord(turns, record)
    }
    assert.deepStrictEqual(turns, turnsFromRecords(records))
  }),
)
