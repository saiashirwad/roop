import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Ref, Schema, Stream } from "effect"
import { AiError, Chat, LanguageModel, Prompt, Tool } from "effect/unstable/ai"

import type { AgentEvent } from "../src/AgentEvent.ts"
import { hooksNoop, ToolRejected } from "../src/AgentHooks.ts"
import { runStep, type ErasedToolkit } from "../src/runStep.ts"
import type { SessionEvent } from "../src/SessionEvent.ts"
import { SessionId } from "../src/SessionId.ts"
import { scripted } from "../src/Testing.ts"
import { makeToolScheduler } from "../src/toolScheduler.ts"

const Echo = Tool.make("echo", {
  description: "echo note",
  parameters: Schema.Struct({ note: Schema.String }),
  success: Schema.Struct({ reply: Schema.String }),
})

const makeInterruptMock = (isInterrupted = false) => ({
  isInterrupted: Effect.succeed(isInterrupted),
  await: Effect.never,
})

const makeEchoToolkit = (): ErasedToolkit => ({
  tools: {
    echo: Echo,
  },
  handle: (_name, params) => {
    /* SAFETY: Echo tool parameters match Schema.Struct({ note: Schema.String }). */
    const { note } = params as { readonly note: string }
    return Effect.succeed(
      Stream.make({
        result: { reply: note },
        encodedResult: { reply: note },
        isFailure: false,
        preliminary: false,
      }),
    )
  },
})

describe("runStep", () => {
  it.effect("executes single text step, emitting live and journal events", () =>
    Effect.gen(function* () {
      const sid = SessionId.make("step-test-1")
      const journal = yield* Ref.make<Array<SessionEvent>>([])
      const live = yield* Ref.make<Array<AgentEvent>>([])
      const append = (ev: SessionEvent) => Ref.update(journal, (all) => [...all, ev])
      const emit = (ev: AgentEvent) => Ref.update(live, (all) => [...all, ev])

      const model = yield* scripted([
        [
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "Hello " },
          { type: "text-delta", id: "t1", delta: "world!" },
          { type: "text-end", id: "t1" },
        ],
      ])

      const chat = yield* Chat.fromPrompt(Prompt.empty)
      const scheduler = yield* makeToolScheduler("unbounded")
      const toolkit = makeEchoToolkit()

      const outcome = yield* runStep({
        sessionId: sid,
        turn: 1,
        step: 1,
        chat,
        model,
        toolkit: Effect.succeed(toolkit),
        interrupt: makeInterruptMock(false),
        append,
        emit,
        hooks: hooksNoop,
        scheduler,
      })

      assert.strictEqual(outcome._tag, "Stop")
      if (outcome._tag === "Stop") {
        assert.strictEqual(outcome.toolCallCount, 0)
      }

      const liveEvents = yield* Ref.get(live)
      assert.deepStrictEqual(liveEvents, [
        { _tag: "TextDelta", delta: "Hello " },
        { _tag: "TextDelta", delta: "world!" },
      ])

      const journalEvents = yield* Ref.get(journal)
      assert.ok(journalEvents.length >= 4)
      const start = journalEvents[0]
      const req = journalEvents[1]
      const msg = journalEvents[2]
      const end = journalEvents[3]
      assert.ok(start !== undefined && start._tag === "step/start")
      assert.ok(req !== undefined && req._tag === "model/request")
      assert.ok(msg !== undefined && msg._tag === "assistant/message")
      assert.deepStrictEqual(end, { _tag: "step/end", reason: "completed" })
    }),
  )

  it.effect("executes tool calls and returns ToolCalls outcome", () =>
    Effect.gen(function* () {
      const sid = SessionId.make("step-test-2")
      const journal = yield* Ref.make<Array<SessionEvent>>([])
      const live = yield* Ref.make<Array<AgentEvent>>([])
      const append = (ev: SessionEvent) => Ref.update(journal, (all) => [...all, ev])
      const emit = (ev: AgentEvent) => Ref.update(live, (all) => [...all, ev])

      const model = yield* scripted([
        [
          {
            type: "tool-call",
            id: "call_echo_1",
            name: "echo",
            params: { note: "test note" },
          },
        ],
      ])

      const chat = yield* Chat.fromPrompt(Prompt.empty)
      const scheduler = yield* makeToolScheduler("unbounded")
      const toolkit = makeEchoToolkit()

      const outcome = yield* runStep({
        sessionId: sid,
        turn: 1,
        step: 1,
        chat,
        model,
        toolkit: Effect.succeed(toolkit),
        interrupt: makeInterruptMock(false),
        append,
        emit,
        hooks: hooksNoop,
        scheduler,
      })

      assert.strictEqual(outcome._tag, "ToolCalls")
      if (outcome._tag === "ToolCalls") {
        assert.strictEqual(outcome.toolCallCount, 1)
      }

      const liveEvents = yield* Ref.get(live)
      assert.ok(liveEvents.some((e) => e._tag === "ToolCall" && e.id === "call_echo_1"))
      assert.ok(
        liveEvents.some((e) => {
          if (e._tag !== "ToolResult" || e.id !== "call_echo_1") return false
          /* SAFETY: Echo tool success returns { reply: string }. */
          const res = e.result as { readonly reply: string }
          return res.reply === "test note"
        }),
      )

      const journalEvents = yield* Ref.get(journal)
      assert.ok(journalEvents.some((e) => e._tag === "tool/call" && e.id === "call_echo_1"))
      assert.ok(journalEvents.some((e) => e._tag === "tool/result" && e.id === "call_echo_1"))
      assert.deepStrictEqual(journalEvents[journalEvents.length - 1], {
        _tag: "step/end",
        reason: "completed",
      })
    }),
  )

  it.effect("handles ToolRejected hook with execution-denied result", () =>
    Effect.gen(function* () {
      const sid = SessionId.make("step-test-3")
      const journal = yield* Ref.make<Array<SessionEvent>>([])
      const live = yield* Ref.make<Array<AgentEvent>>([])
      const append = (ev: SessionEvent) => Ref.update(journal, (all) => [...all, ev])
      const emit = (ev: AgentEvent) => Ref.update(live, (all) => [...all, ev])

      const model = yield* scripted([
        [
          {
            type: "tool-call",
            id: "call_echo_rejected",
            name: "echo",
            params: { note: "vetoed" },
          },
        ],
      ])

      const chat = yield* Chat.fromPrompt(Prompt.empty)
      const scheduler = yield* makeToolScheduler("unbounded")
      const toolkit = makeEchoToolkit()

      const outcome = yield* runStep({
        sessionId: sid,
        turn: 1,
        step: 1,
        chat,
        model,
        toolkit: Effect.succeed(toolkit),
        interrupt: makeInterruptMock(false),
        append,
        emit,
        hooks: {
          ...hooksNoop,
          beforeToolExecute: () => Effect.fail(new ToolRejected({ reason: "policy violation" })),
        },
        scheduler,
      })

      assert.strictEqual(outcome._tag, "ToolCalls")

      const liveEvents = yield* Ref.get(live)
      const toolResult = liveEvents.find(
        (e) => e._tag === "ToolResult" && e.id === "call_echo_rejected",
      )
      assert.ok(toolResult !== undefined)
      if (toolResult && toolResult._tag === "ToolResult") {
        assert.strictEqual(toolResult.isFailure, true)
        assert.deepStrictEqual(toolResult.result, {
          type: "execution-denied",
          reason: "policy violation",
        })
      }
    }),
  )

  it.effect("returns Interrupted on cooperative interrupt during step", () =>
    Effect.gen(function* () {
      const sid = SessionId.make("step-test-4")
      const journal = yield* Ref.make<Array<SessionEvent>>([])
      const append = (ev: SessionEvent) => Ref.update(journal, (all) => [...all, ev])

      const model = yield* LanguageModel.make({
        generateText: () => Effect.succeed([]),
        streamText: () => Stream.fromEffect(Effect.never),
      })

      const chat = yield* Chat.fromPrompt(Prompt.empty)
      const scheduler = yield* makeToolScheduler("unbounded")
      const toolkit = makeEchoToolkit()

      const outcome = yield* runStep({
        sessionId: sid,
        turn: 1,
        step: 1,
        chat,
        model,
        toolkit: Effect.succeed(toolkit),
        interrupt: {
          isInterrupted: Effect.succeed(false),
          await: Effect.void,
        },
        append,
        emit: () => Effect.void,
        hooks: hooksNoop,
        scheduler,
      })

      assert.strictEqual(outcome._tag, "Interrupted")
      const journalEvents = yield* Ref.get(journal)
      assert.deepStrictEqual(journalEvents[journalEvents.length - 1], {
        _tag: "step/end",
        reason: "interrupted",
      })
    }),
  )

  it.effect("records failure marker and re-fails on error", () =>
    Effect.gen(function* () {
      const sid = SessionId.make("step-test-5")
      const journal = yield* Ref.make<Array<SessionEvent>>([])
      const append = (ev: SessionEvent) => Ref.update(journal, (all) => [...all, ev])

      const model = yield* LanguageModel.make({
        generateText: () => Effect.succeed([]),
        streamText: () =>
          Stream.fail(
            AiError.make({
              module: "test",
              method: "streamText",
              reason: new AiError.UnknownError({ description: "boom" }),
            }),
          ),
      })

      const chat = yield* Chat.fromPrompt(Prompt.empty)
      const scheduler = yield* makeToolScheduler("unbounded")
      const toolkit = makeEchoToolkit()

      const exit = yield* Effect.exit(
        runStep({
          sessionId: sid,
          turn: 1,
          step: 1,
          chat,
          model,
          toolkit: Effect.succeed(toolkit),
          interrupt: makeInterruptMock(false),
          append,
          emit: () => Effect.void,
          hooks: hooksNoop,
          scheduler,
        }),
      )

      assert.ok(Exit.isFailure(exit))
      const journalEvents = yield* Ref.get(journal)
      const last = journalEvents[journalEvents.length - 1]
      assert.ok(last !== undefined)
      assert.strictEqual(last._tag, "step/end")
      if (last._tag === "step/end") {
        assert.strictEqual(last.reason, "failed")
      }
    }),
  )
})
