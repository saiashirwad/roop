import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Schema, Stream } from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai"

import { Agent, AgentLiveToolkit } from "../src/Agent.ts"
import { AgentBus, AgentBusMemory, sessionEventsToAgentEvents } from "../src/AgentBus.ts"
import type { AgentEvent, SessionEvent } from "../src/AgentEvents.ts"
import { cryptoWeb } from "../src/cryptoWeb.ts"
import { SessionId } from "../src/DomainIds.ts"
import { SessionJournalMemory } from "../src/SessionJournal.ts"
import { scripted } from "../src/Testing.ts"

const Echo = Tool.make("echo", {
  description: "echo a note back",
  parameters: Schema.Struct({ note: Schema.String }),
  success: Schema.Struct({ reply: Schema.String }),
})

const EchoToolkit = Toolkit.make(Echo)

describe("AgentBus", () => {
  it("sessionEventsToAgentEvents converts historical session events to agent events", () => {
    const sessionEvents: ReadonlyArray<SessionEvent> = [
      { _tag: "system/message", content: "system" },
      { _tag: "user/message", content: "hi" },
      { _tag: "step/start", index: 1 },
      {
        _tag: "assistant/message",
        parts: [
          { type: "reasoning", text: "thinking" },
          { type: "text", text: "hello" },
        ],
      },
      {
        _tag: "tool/call",
        id: "call1",
        name: "readFile",
        params: { path: "a.ts" },
        providerExecuted: false,
      },
      {
        _tag: "tool/result",
        id: "call1",
        name: "readFile",
        isFailure: false,
        result: "file content",
        providerExecuted: false,
      },
      { _tag: "turn/end", reason: "completed" },
    ]

    const projected = sessionEventsToAgentEvents(sessionEvents)
    assert.strictEqual(projected.length, 5)
    assert.deepStrictEqual(projected[0], { _tag: "ReasoningDelta", delta: "thinking" })
    assert.deepStrictEqual(projected[1], { _tag: "TextDelta", delta: "hello" })
    assert.deepStrictEqual(projected[2], {
      _tag: "ToolCall",
      id: "call1",
      name: "readFile",
      params: { path: "a.ts" },
      providerExecuted: false,
    })
    assert.deepStrictEqual(projected[3], {
      _tag: "ToolResult",
      id: "call1",
      name: "readFile",
      isFailure: false,
      result: "file content",
      providerExecuted: false,
    })
    assert.deepStrictEqual(projected[4], { _tag: "Finish", reason: "completed" })
  })

  it("replayFromStep uses step/start index as a session-global cursor", () => {
    const projected = sessionEventsToAgentEvents(
      [
        { _tag: "step/start", index: 1 },
        { _tag: "assistant/message", parts: [{ type: "text", text: "turn1-step1" }] },
        { _tag: "turn/end", reason: "completed" },
        { _tag: "step/start", index: 2 },
        { _tag: "assistant/message", parts: [{ type: "text", text: "turn2-step1" }] },
        { _tag: "turn/end", reason: "completed" },
      ],
      2,
    )

    assert.deepStrictEqual(
      projected.map((event) => event._tag),
      ["TextDelta", "Finish"],
    )
    assert.deepStrictEqual(projected[0], { _tag: "TextDelta", delta: "turn2-step1" })
  })

  it("projects only the terminal turn/end as Finish", () => {
    const projected = sessionEventsToAgentEvents([
      { _tag: "step/start", index: 1 },
      { _tag: "assistant/message", parts: [{ type: "text", text: "first" }] },
      { _tag: "turn/end", reason: "completed" },
      { _tag: "user/message", content: "continue" },
      { _tag: "step/start", index: 2 },
      { _tag: "assistant/message", parts: [{ type: "text", text: "second" }] },
      { _tag: "turn/end", reason: "completed" },
    ])

    assert.deepStrictEqual(
      projected.map((event) => event._tag),
      ["TextDelta", "TextDelta", "Finish"],
    )
    assert.deepStrictEqual(projected[2], { _tag: "Finish", reason: "completed" })
  })

  it.effect("AgentBus publishes and distributes events to active session subscribers", () =>
    Effect.gen(function* () {
      const bus = yield* AgentBus

      const historyEvent: AgentEvent = { _tag: "TextDelta", delta: "already published" }
      const testEvent: AgentEvent = { _tag: "TextDelta", delta: "streaming text" }

      yield* bus.publish({ sessionId: SessionId.make("session-123"), event: historyEvent })
      const stream = yield* bus.subscribe("session-123")
      const streamFiber = yield* Effect.forkChild(Stream.runCollect(stream.pipe(Stream.take(2))))

      yield* Effect.yieldNow
      yield* bus.publish({ sessionId: SessionId.make("session-123"), event: testEvent })

      const collected = yield* Fiber.join(streamFiber)
      assert.deepStrictEqual([...collected], [historyEvent, testEvent])
    }).pipe(Effect.scoped, Effect.provide(AgentBusMemory)),
  )

  it.effect("AgentBus delivers Finish to a live subscriber", () =>
    Effect.gen(function* () {
      const bus = yield* AgentBus
      const sessionId = SessionId.make("session-live-finish")
      const finish: AgentEvent = { _tag: "Finish", reason: "completed" }
      const stream = yield* bus.subscribe(sessionId)

      yield* bus.publish({ sessionId, event: finish })

      const collected = yield* Stream.runCollect(stream.pipe(Stream.take(1)))
      assert.deepStrictEqual([...collected], [finish])
    }).pipe(Effect.scoped, Effect.provide(AgentBusMemory)),
  )

  it.effect("AgentBus retains no completed-run events for subscribers joining after Finish", () =>
    Effect.gen(function* () {
      const bus = yield* AgentBus
      const sessionId = SessionId.make("session-after-finish")
      const freshEvent: AgentEvent = { _tag: "TextDelta", delta: "fresh" }

      yield* bus.publish({ sessionId, event: { _tag: "TextDelta", delta: "completed" } })
      yield* bus.publish({ sessionId, event: { _tag: "Finish", reason: "completed" } })
      const stream = yield* bus.subscribe(sessionId)
      yield* bus.publish({ sessionId, event: freshEvent })

      const collected = yield* Stream.runCollect(stream.pipe(Stream.take(1)))
      assert.deepStrictEqual([...collected], [freshEvent])
    }).pipe(Effect.scoped, Effect.provide(AgentBusMemory)),
  )

  it.effect("AgentBus replays only the new run after a completed run", () =>
    Effect.gen(function* () {
      const bus = yield* AgentBus
      const sessionId = SessionId.make("session-reused")

      yield* bus.publish({ sessionId, event: { _tag: "TextDelta", delta: "old" } })
      yield* bus.publish({ sessionId, event: { _tag: "Finish", reason: "completed" } })
      yield* bus.publish({ sessionId, event: { _tag: "TextDelta", delta: "new" } })

      const stream = yield* bus.subscribe(sessionId)
      const collected = yield* Stream.runCollect(stream.pipe(Stream.take(1)))
      assert.deepStrictEqual([...collected], [{ _tag: "TextDelta", delta: "new" }])
    }).pipe(Effect.scoped, Effect.provide(AgentBusMemory)),
  )

  it.effect("Agent.subscribe replays past events for completed sessions", () =>
    Effect.gen(function* () {
      const agent = yield* Agent

      // Step 1: Run prompt with tool call + response
      const events = yield* Stream.runCollect(
        agent.prompt({ prompt: "hello", sessionId: "s-replay" }),
      ).pipe(Effect.map((chunk) => [...chunk]))
      assert.strictEqual(events.length, 4)

      // Step 2: Now subscribe after run is complete
      const replayed = yield* Stream.runCollect(agent.subscribe("s-replay")).pipe(
        Effect.map((chunk) => [...chunk]),
      )

      assert.strictEqual(replayed.length, 3)
      assert.deepStrictEqual(
        replayed.map((e) => e._tag),
        ["ToolCall", "ToolResult", "Finish"],
      )
    }).pipe(
      Effect.provide(
        AgentLiveToolkit(EchoToolkit, {
          models: [
            {
              id: "deepseek-chat",
              provider: "deepseek",
              layer: Layer.effect(
                LanguageModel.LanguageModel,
                scripted([
                  [{ type: "tool-call" as const, id: "c1", name: "echo", params: { note: "hi" } }],
                  [
                    { type: "text-delta" as const, id: "t1", delta: "done" },
                    { type: "text-end" as const, id: "t1" },
                  ],
                ]),
              ),
            },
          ],
        }).pipe(
          Layer.provide(SessionJournalMemory),
          Layer.provide(cryptoWeb),
          Layer.provide(
            EchoToolkit.toLayer({
              echo: ({ note }) => Effect.succeed({ reply: note }),
            }),
          ),
        ),
      ),
    ),
  )
})
