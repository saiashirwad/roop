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

  it.effect("AgentBus publishes and distributes events to active session subscribers", () =>
    Effect.gen(function* () {
      const bus = yield* AgentBus

      const testEvent: AgentEvent = { _tag: "TextDelta", delta: "streaming text" }

      const streamFiber = yield* Effect.forkChild(
        Stream.runCollect(bus.subscribe("session-123").pipe(Stream.take(1))),
      )

      yield* Effect.yieldNow
      yield* bus.publish({ sessionId: SessionId.make("session-123"), event: testEvent })

      const collected = yield* Fiber.join(streamFiber)
      assert.deepStrictEqual([...collected], [testEvent])
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
