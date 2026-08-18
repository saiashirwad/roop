import { assert, describe, it } from "@effect/vitest"
import { Deferred, Duration, Effect, Exit, Fiber, Queue, Ref, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { AiError, Chat, LanguageModel, Prompt, Tool } from "effect/unstable/ai"

import type { AgentEvent, SessionEvent } from "../src/AgentEvents.ts"
import { hooksNoop, ToolRejected } from "../src/AgentHooks.ts"
import { SessionId } from "../src/DomainIds.ts"
import { InterruptSignal } from "../src/RunRegistry.ts"
import { runStep, type ErasedToolkit } from "../src/runStep.ts"
import { scripted } from "../src/Testing.ts"
import { makeToolScheduler } from "../src/toolScheduler.ts"

const Echo = Tool.make("echo", {
  description: "echo note",
  parameters: Schema.Struct({ note: Schema.String }),
  success: Schema.Struct({ reply: Schema.String }),
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
        interrupt: InterruptSignal.noop(),
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
        interrupt: InterruptSignal.noop(),
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
      assert.ok(liveEvents.some((e) => e._tag === "ToolCall" && e.id === "step-test-2:1:1:echo:1"))
      assert.ok(
        liveEvents.some((e) => {
          if (e._tag !== "ToolResult" || e.id !== "step-test-2:1:1:echo:1") return false
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
        interrupt: InterruptSignal.noop(),
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
        (e) => e._tag === "ToolResult" && e.id === "step-test-3:1:1:echo:1",
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
        streamText: () =>
          Stream.make({ type: "text-delta" as const, id: "timeout", delta: "start" }).pipe(
            Stream.concat(Stream.never),
          ),
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
        interrupt: InterruptSignal.interrupted(),
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

  it.effect("handles pre-step steer interruption", () =>
    Effect.gen(function* () {
      const sid = SessionId.make("step-steer-pre")
      const journal = yield* Ref.make<Array<SessionEvent>>([])
      const steerQueue = yield* Queue.unbounded<string>()
      yield* Queue.offer(steerQueue, "Do this instead")

      const model = yield* scripted([])
      const chat = yield* Chat.fromPrompt(Prompt.empty)
      const toolkit = makeEchoToolkit()
      const scheduler = yield* makeToolScheduler("unbounded")

      const outcome = yield* runStep({
        sessionId: sid,
        turn: 1,
        step: 1,
        chat,
        model,
        toolkit: Effect.succeed(toolkit),
        interrupt: InterruptSignal.make({ steerQueue }),
        append: (event) => Ref.update(journal, (all) => [...all, event]),
        emit: () => Effect.void,
        hooks: hooksNoop,
        scheduler,
      })

      assert.strictEqual(outcome._tag, "Steered")
      if (outcome._tag === "Steered") {
        assert.strictEqual(outcome.steerPrompt, "Do this instead")
        assert.deepStrictEqual(outcome.partialParts, [])
      }
      const journalEvents = yield* Ref.get(journal)
      assert.deepStrictEqual(journalEvents[journalEvents.length - 1], {
        _tag: "step/end",
        reason: "interrupted",
      })
    }),
  )

  it.effect(
    "handles mid-stream steer, closing unclosed text tokens and recording partial assistant output",
    () =>
      Effect.gen(function* () {
        const sid = SessionId.make("step-steer-mid")
        const journal = yield* Ref.make<Array<SessionEvent>>([])
        const live = yield* Ref.make<Array<AgentEvent>>([])
        const steerQueue = yield* Queue.unbounded<string>()

        // Hanging model that emits partial text then waits
        const model = yield* LanguageModel.make({
          generateText: () => Effect.succeed([]),
          streamText: () =>
            Stream.make(
              { type: "text-start" as const, id: "t1" },
              { type: "text-delta" as const, id: "t1", delta: "Partial response " },
            ).pipe(Stream.concat(Stream.never)),
        })

        const chat = yield* Chat.fromPrompt(Prompt.empty)
        const toolkit = makeEchoToolkit()
        const scheduler = yield* makeToolScheduler("unbounded")

        const outcome = yield* runStep({
          sessionId: sid,
          turn: 1,
          step: 1,
          chat,
          model,
          toolkit: Effect.succeed(toolkit),
          interrupt: InterruptSignal.make({ steerQueue }),
          append: (event) => Ref.update(journal, (all) => [...all, event]),
          emit: (event) =>
            Effect.gen(function* () {
              yield* Ref.update(live, (all) => [...all, event])
              if (event._tag === "TextDelta") {
                yield* Queue.offer(steerQueue, "Change direction")
              }
            }),
          hooks: hooksNoop,
          scheduler,
        })

        assert.strictEqual(outcome._tag, "Steered")
        if (outcome._tag === "Steered") {
          assert.strictEqual(outcome.steerPrompt, "Change direction")
          assert.ok(outcome.partialParts.length >= 3)
          // Verify synthetic text-end was added
          const lastPart = outcome.partialParts[outcome.partialParts.length - 1]
          assert.strictEqual(lastPart?.type, "text-end")
          /* SAFETY: Synthetic text-end carries the open stream part ID. */
          assert.strictEqual((lastPart as any)?.id, "t1")
        }

        const journalEvents = yield* Ref.get(journal)
        const assistantMsg = journalEvents.find((e) => e._tag === "assistant/message")
        assert.ok(assistantMsg !== undefined)
        if (assistantMsg?._tag === "assistant/message") {
          assert.deepStrictEqual(assistantMsg.parts, [{ type: "text", text: "Partial response " }])
        }
      }),
  )

  it.effect(
    "handles mid-stream steer with unclosed reasoning tokens, synthesizing reasoning-end",
    () =>
      Effect.gen(function* () {
        const sid = SessionId.make("step-steer-reasoning")
        const journal = yield* Ref.make<Array<SessionEvent>>([])
        const live = yield* Ref.make<Array<AgentEvent>>([])
        const steerQueue = yield* Queue.unbounded<string>()

        const model = yield* LanguageModel.make({
          generateText: () => Effect.succeed([]),
          streamText: () =>
            Stream.make(
              { type: "reasoning-start" as const, id: "r1" },
              { type: "reasoning-delta" as const, id: "r1", delta: "Thinking deeply..." },
            ).pipe(Stream.concat(Stream.never)),
        })

        const chat = yield* Chat.fromPrompt(Prompt.empty)
        const toolkit = makeEchoToolkit()
        const scheduler = yield* makeToolScheduler("unbounded")

        const outcome = yield* runStep({
          sessionId: sid,
          turn: 1,
          step: 1,
          chat,
          model,
          toolkit: Effect.succeed(toolkit),
          interrupt: InterruptSignal.make({ steerQueue }),
          append: (event) => Ref.update(journal, (all) => [...all, event]),
          emit: (event) =>
            Effect.gen(function* () {
              yield* Ref.update(live, (all) => [...all, event])
              if (event._tag === "ReasoningDelta") {
                yield* Queue.offer(steerQueue, "Stop thinking")
              }
            }),
          hooks: hooksNoop,
          scheduler,
        })

        assert.strictEqual(outcome._tag, "Steered")
        if (outcome._tag === "Steered") {
          assert.strictEqual(outcome.steerPrompt, "Stop thinking")
          const lastPart = outcome.partialParts[outcome.partialParts.length - 1]
          assert.strictEqual(lastPart?.type, "reasoning-end")
          /* SAFETY: Synthetic reasoning-end carries the open stream part ID. */
          assert.strictEqual((lastPart as any)?.id, "r1")
        }

        const journalEvents = yield* Ref.get(journal)
        const assistantMsg = journalEvents.find((e) => e._tag === "assistant/message")
        assert.ok(assistantMsg !== undefined)
        if (assistantMsg?._tag === "assistant/message") {
          assert.deepStrictEqual(assistantMsg.parts, [
            { type: "reasoning", text: "Thinking deeply..." },
          ])
        }
      }),
  )

  it.effect("interrupts active tool execution when steered", () =>
    Effect.gen(function* () {
      const sid = SessionId.make("step-steer-tool")
      const journal = yield* Ref.make<Array<SessionEvent>>([])
      const toolStarted = yield* Deferred.make<void>()
      const toolInterrupted = yield* Deferred.make<void>()
      const steerQueue = yield* Queue.unbounded<string>()

      const BlockingEcho: ErasedToolkit = {
        tools: { echo: Echo },
        handle: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(toolStarted, undefined)
            return Stream.fromEffect(
              Effect.never.pipe(
                Effect.onInterrupt(() => Deferred.succeed(toolInterrupted, undefined)),
              ),
            )
          }),
      }

      const model = yield* scripted([
        [{ type: "tool-call", id: "c1", name: "echo", params: { note: "hang" } }],
      ])

      const chat = yield* Chat.fromPrompt(Prompt.empty)
      const scheduler = yield* makeToolScheduler("unbounded")

      const stepFiber = yield* Effect.forkChild(
        runStep({
          sessionId: sid,
          turn: 1,
          step: 1,
          chat,
          model,
          toolkit: Effect.succeed(BlockingEcho),
          interrupt: InterruptSignal.make({ steerQueue }),
          append: (event) => Ref.update(journal, (all) => [...all, event]),
          emit: () => Effect.void,
          hooks: hooksNoop,
          scheduler,
        }),
      )

      // Wait until tool starts executing
      yield* Deferred.await(toolStarted)

      // Steer while tool is in flight
      yield* Queue.offer(steerQueue, "Abort tool and do this")

      const outcome = yield* Fiber.join(stepFiber)
      assert.strictEqual(outcome._tag, "Steered")
      if (outcome._tag === "Steered") {
        assert.strictEqual(outcome.steerPrompt, "Abort tool and do this")
      }

      // Verify tool execution was interrupted
      yield* Deferred.await(toolInterrupted)

      const journalEvents = yield* Ref.get(journal)
      assert.deepStrictEqual(journalEvents[journalEvents.length - 1], {
        _tag: "step/end",
        reason: "interrupted",
      })
    }),
  )

  it.effect("times out the complete model request stream", () =>
    Effect.gen(function* () {
      const model = yield* LanguageModel.make({
        generateText: () => Effect.succeed([]),
        streamText: () => Stream.never,
      })
      const chat = yield* Chat.fromPrompt(Prompt.empty)
      const fiber = yield* runStep({
        sessionId: SessionId.make("step-test-model-timeout"),
        turn: 1,
        step: 1,
        chat,
        model,
        toolkit: Effect.succeed(makeEchoToolkit()),
        interrupt: InterruptSignal.noop(),
        append: () => Effect.void,
        emit: () => Effect.void,
        hooks: hooksNoop,
        scheduler: yield* makeToolScheduler("unbounded"),
        policy: { modelTimeout: Duration.millis(20) },
      }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust(Duration.millis(20))
      const exit = yield* Effect.exit(Fiber.join(fiber))
      assert.ok(Exit.isFailure(exit))
    }),
  )

  it.effect("times out complete tool result consumption", () =>
    Effect.gen(function* () {
      const model = yield* scripted([
        [{ type: "tool-call", id: "slow", name: "echo", params: { note: "wait" } }],
      ])
      const chat = yield* Chat.fromPrompt(Prompt.empty)
      const toolkit: ErasedToolkit = {
        tools: { echo: Echo },
        handle: () => Effect.succeed(Stream.never),
      }
      const fiber = yield* runStep({
        sessionId: SessionId.make("step-test-tool-timeout"),
        turn: 1,
        step: 1,
        chat,
        model,
        toolkit: Effect.succeed(toolkit),
        interrupt: InterruptSignal.noop(),
        append: () => Effect.void,
        emit: () => Effect.void,
        hooks: hooksNoop,
        scheduler: yield* makeToolScheduler("unbounded"),
        policy: { toolTimeout: Duration.millis(20) },
      }).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust(Duration.millis(20))
      const exit = yield* Effect.exit(Fiber.join(fiber))
      assert.ok(Exit.isFailure(exit))
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
          interrupt: InterruptSignal.noop(),
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

  it.effect("bounds oversized encoded tool results and continues with a failed result", () =>
    Effect.gen(function* () {
      const sid = SessionId.make("step-test-large")
      const journal = yield* Ref.make<Array<SessionEvent>>([])
      const live = yield* Ref.make<Array<AgentEvent>>([])
      const model = yield* scripted([
        [{ type: "tool-call", id: "large", name: "echo", params: { note: "a long note" } }],
      ])
      const chat = yield* Chat.fromPrompt(Prompt.empty)
      const toolkit = makeEchoToolkit()
      const outcome = yield* runStep({
        sessionId: sid,
        turn: 1,
        step: 1,
        chat,
        model,
        toolkit: Effect.succeed(toolkit),
        interrupt: InterruptSignal.noop(),
        append: (event) => Ref.update(journal, (all) => [...all, event]),
        emit: (event) => Ref.update(live, (all) => [...all, event]),
        hooks: hooksNoop,
        scheduler: yield* makeToolScheduler("unbounded"),
        policy: { maxToolOutputBytes: 8 },
      })
      assert.strictEqual(outcome._tag, "ToolCalls")
      const result = (yield* Ref.get(live)).find((event) => event._tag === "ToolResult")
      assert.ok(result !== undefined && result._tag === "ToolResult")
      if (result?._tag === "ToolResult") {
        assert.strictEqual(result.isFailure, true)
        assert.deepStrictEqual(result.result, {
          type: "tool-output-too-large",
          message: "tool output exceeded 8 bytes",
        })
      }
    }),
  )
})
