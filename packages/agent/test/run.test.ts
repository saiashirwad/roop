import { assert, describe, it } from "@effect/vitest"
import { Deferred, Duration, Effect, Exit, Fiber, Queue, Ref, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { AiError, Chat, LanguageModel, Prompt, Tool } from "effect/unstable/ai"

import type { AgentEvent, SessionEvent } from "../src/AgentEvents.ts"
import { hooksNoop, ToolRejected, type AgentHooksInterface } from "../src/AgentHooks.ts"
import type { ErasedToolkit } from "../src/AgentTools.ts"
import { SessionId } from "../src/DomainIds.ts"
import { run, type RunOptions } from "../src/run.ts"
import { runError, type RunError } from "../src/RunError.ts"
import { InterruptSignal } from "../src/RunSignal.ts"
import { scripted } from "../src/Testing.ts"

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

const isTag = <T extends AgentEvent["_tag"]>(
  event: AgentEvent,
  tag: T,
): event is Extract<AgentEvent, { _tag: T }> => event._tag === tag

interface Harness {
  readonly journal: Ref.Ref<Array<SessionEvent>>
  readonly events: Ref.Ref<Array<AgentEvent>>
  /** Collect the live stream, optionally observing each event as it arrives. */
  readonly collect: (
    observe?: (event: AgentEvent) => Effect.Effect<void>,
  ) => Effect.Effect<void, RunError>
  readonly lastEvent: <T extends AgentEvent["_tag"]>(
    tag: T,
  ) => Effect.Effect<Extract<AgentEvent, { _tag: T }> | undefined>
}

const makeHarness = (
  model: LanguageModel.Service,
  scriptExtras?: {
    readonly toolkit?: ErasedToolkit
    readonly hooks?: AgentHooksInterface
    readonly interrupt?: RunOptions["interrupt"]
    readonly policy?: RunOptions["policy"]
    readonly onJournal?: (event: SessionEvent) => Effect.Effect<void>
  },
): Effect.Effect<Harness> =>
  Effect.gen(function* () {
    const journal = yield* Ref.make<Array<SessionEvent>>([])
    const events = yield* Ref.make<Array<AgentEvent>>([])
    const chat = yield* Chat.fromPrompt(Prompt.empty)
    const append = (event: SessionEvent) =>
      Ref.update(journal, (all) => [...all, event]).pipe(
        Effect.andThen(scriptExtras?.onJournal?.(event) ?? Effect.void),
      )
    const record = (event: AgentEvent) => Ref.update(events, (all) => [...all, event])
    const base: RunOptions = {
      sessionId: SessionId.make("run-test"),
      chat,
      model,
      toolkit: Effect.succeed(scriptExtras?.toolkit ?? makeEchoToolkit()),
      interrupt: scriptExtras?.interrupt ?? InterruptSignal.noop(),
      append,
      hooks: scriptExtras?.hooks ?? hooksNoop,
      policy: scriptExtras?.policy,
    }
    const collect = (observe?: (event: AgentEvent) => Effect.Effect<void>) =>
      run(base).pipe(
        Stream.tap((event) => record(event).pipe(Effect.andThen(observe?.(event) ?? Effect.void))),
        Stream.runDrain,
      )
    const lastEvent = <T extends AgentEvent["_tag"]>(tag: T) =>
      Ref.get(events).pipe(
        Effect.map((all) => {
          for (let i = all.length - 1; i >= 0; i--) {
            const event = all[i]!
            if (isTag(event, tag)) return event
          }
          return undefined
        }),
      )
    return { journal, events, collect, lastEvent }
  })

describe("run", () => {
  it.effect("executes a single text step, emitting live events and journal spans", () =>
    Effect.gen(function* () {
      const model = yield* scripted([
        [
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: "Hello " },
          { type: "text-delta", id: "t1", delta: "world!" },
          { type: "text-end", id: "t1" },
        ],
      ])
      const h = yield* makeHarness(model)

      yield* h.collect()

      const live = yield* Ref.get(h.events)
      assert.deepStrictEqual(live, [
        { _tag: "TextDelta", delta: "Hello " },
        { _tag: "TextDelta", delta: "world!" },
        { _tag: "Finish", reason: "completed" },
      ])

      const journal = yield* Ref.get(h.journal)
      const tags = journal.map((event) => event._tag)
      assert.deepStrictEqual(tags, [
        "turn/start",
        "step/start",
        "model/request",
        "assistant/message",
        "step/end",
        "turn/end",
      ])
      assert.deepStrictEqual(journal[4], { _tag: "step/end", reason: "completed" })
      assert.deepStrictEqual(journal[5], { _tag: "turn/end", reason: "completed" })
    }),
  )

  it.effect("executes tool calls across turns, correlating live ids to journal ids", () =>
    Effect.gen(function* () {
      const model = yield* scripted([
        [{ type: "tool-call", id: "call_echo_1", name: "echo", params: { note: "test note" } }],
        [
          { type: "text-start", id: "t1" },
          { type: "text-end", id: "t1" },
        ],
      ])
      const h = yield* makeHarness(model)

      yield* h.collect()

      const live = yield* Ref.get(h.events)
      const call = live.find((event) => event._tag === "ToolCall")
      const result = live.find((event) => event._tag === "ToolResult")
      assert.ok(call !== undefined && call._tag === "ToolCall")
      // Live ids are correlated tokens; the provider's raw id stays in the journal.
      assert.notStrictEqual(call.id, "call_echo_1")
      assert.ok(result !== undefined && result._tag === "ToolResult")
      assert.strictEqual(result.id, call.id)
      assert.strictEqual(result.isFailure, false)
      /* SAFETY: Echo tool success returns { reply: string }. */
      assert.deepStrictEqual((result.result as { reply: string }).reply, "test note")
      assert.strictEqual((yield* h.lastEvent("Finish"))?.reason, "completed")

      const journal = yield* Ref.get(h.journal)
      assert.ok(journal.some((event) => event._tag === "tool/call" && event.id === "call_echo_1"))
      assert.ok(journal.some((event) => event._tag === "tool/result" && event.id === "call_echo_1"))
      // Tool calls continue the same turn as a second step.
      assert.strictEqual(journal.filter((event) => event._tag === "turn/start").length, 1)
      assert.strictEqual(journal.filter((event) => event._tag === "step/start").length, 2)
    }),
  )

  it.effect("correlates out-of-order tool results by provider call", () =>
    Effect.gen(function* () {
      const releaseSlow = yield* Deferred.make<void>()
      const Slow = Tool.make("slow", {
        description: "wait for release",
        parameters: Schema.Struct({ note: Schema.String }),
        success: Schema.Struct({ reply: Schema.String }),
      })
      const Fast = Tool.make("fast", {
        description: "return immediately",
        parameters: Schema.Struct({ note: Schema.String }),
        success: Schema.Struct({ reply: Schema.String }),
      })
      const toolkit: ErasedToolkit = {
        tools: { slow: Slow, fast: Fast },
        handle: (name, params) => {
          /* SAFETY: Both definitions use the same note and reply schemas. */
          const { note } = params as { readonly note: string }
          const ready = name === "slow" ? Deferred.await(releaseSlow) : Effect.void
          return Effect.succeed(
            Stream.fromEffect(
              ready.pipe(
                Effect.as({
                  result: { reply: note },
                  encodedResult: { reply: note },
                  isFailure: false,
                  preliminary: false,
                }),
              ),
            ),
          )
        },
      }
      const model = yield* scripted([
        [
          { type: "tool-call", id: "provider-slow", name: "slow", params: { note: "slow" } },
          { type: "tool-call", id: "provider-fast", name: "fast", params: { note: "fast" } },
        ],
        [
          { type: "text-start", id: "done" },
          { type: "text-end", id: "done" },
        ],
      ])
      const h = yield* makeHarness(model, { toolkit })

      yield* h.collect((event) =>
        event._tag === "ToolResult" && event.name === "fast"
          ? Deferred.succeed(releaseSlow, undefined).pipe(Effect.asVoid)
          : Effect.void,
      )

      const live = yield* Ref.get(h.events)
      const calls = live.filter((event) => event._tag === "ToolCall")
      const results = live.filter((event) => event._tag === "ToolResult")
      assert.deepStrictEqual(
        calls.map((event) => event.name),
        ["slow", "fast"],
      )
      assert.notStrictEqual(calls[0]!.id, "provider-slow")
      assert.notStrictEqual(calls[1]!.id, "provider-fast")
      assert.deepStrictEqual(
        results.map((event) => event.name),
        ["fast", "slow"],
      )
      for (const result of results) {
        const call = calls.find((candidate) => candidate.name === result.name)
        assert.ok(call !== undefined)
        assert.strictEqual(result.id, call.id)
      }

      const journal = yield* Ref.get(h.journal)
      const journalCalls = journal.filter((event) => event._tag === "tool/call")
      const journalResults = journal.filter((event) => event._tag === "tool/result")
      assert.deepStrictEqual(
        journalCalls.map((event) => [event.name, event.id]),
        [
          ["slow", "provider-slow"],
          ["fast", "provider-fast"],
        ],
      )
      for (const result of journalResults) {
        assert.ok(journalCalls.some((call) => call.id === result.id && call.name === result.name))
      }
      assert.strictEqual((yield* h.lastEvent("Finish"))?.reason, "completed")
    }),
  )

  it.effect("surfaces ToolRejected hook vetoes as execution-denied results", () =>
    Effect.gen(function* () {
      const model = yield* scripted([
        [{ type: "tool-call", id: "call_echo_rejected", name: "echo", params: { note: "vetoed" } }],
        [
          { type: "text-start", id: "t1" },
          { type: "text-end", id: "t1" },
        ],
      ])
      const h = yield* makeHarness(model, {
        hooks: {
          ...hooksNoop,
          beforeToolExecute: () => Effect.fail(new ToolRejected({ reason: "policy violation" })),
        },
      })

      yield* h.collect()

      const result = yield* h.lastEvent("ToolResult")
      assert.ok(result !== undefined)
      assert.strictEqual(result.isFailure, true)
      assert.deepStrictEqual(result.result, {
        type: "execution-denied",
        reason: "policy violation",
      })
      assert.strictEqual((yield* h.lastEvent("Finish"))?.reason, "completed")
    }),
  )

  it.effect("finishes interrupted on cooperative interrupt during a step", () =>
    Effect.gen(function* () {
      const model = yield* LanguageModel.make({
        generateText: () => Effect.succeed([]),
        streamText: () =>
          Stream.make({ type: "text-delta" as const, id: "timeout", delta: "start" }).pipe(
            Stream.concat(Stream.never),
          ),
      })
      const h = yield* makeHarness(model, { interrupt: InterruptSignal.interrupted() })

      yield* h.collect()

      assert.deepStrictEqual(yield* Ref.get(h.events), [{ _tag: "Finish", reason: "interrupted" }])
      const journal = yield* Ref.get(h.journal)
      // preStep wins the race against the already-signalled interrupt; the
      // model request is admitted and interrupted mid-stream instead.
      assert.deepStrictEqual(
        journal.map((event) => event._tag),
        ["turn/start", "step/start", "model/request", "step/end", "turn/end"],
      )
      assert.deepStrictEqual(journal[3], { _tag: "step/end", reason: "interrupted" })
      assert.deepStrictEqual(journal[4], { _tag: "turn/end", reason: "interrupted" })
    }),
  )

  it.effect("continues with the steer prompt when steered before a step", () =>
    Effect.gen(function* () {
      const steerQueue = yield* Queue.unbounded<string>()
      yield* Queue.offer(steerQueue, "Do this instead")
      const model = yield* scripted([[]])
      const h = yield* makeHarness(model, { interrupt: InterruptSignal.make({ steerQueue }) })

      yield* h.collect()

      const journal = yield* Ref.get(h.journal)
      assert.ok(
        journal.some(
          (event) => event._tag === "user/message" && event.content === "Do this instead",
        ),
      )
      assert.strictEqual((yield* h.lastEvent("Finish"))?.reason, "completed")
    }),
  )

  it.effect("closes unclosed text tokens when steered mid-stream, recording partial output", () =>
    Effect.gen(function* () {
      const steerQueue = yield* Queue.unbounded<string>()
      const modelFinalizers = yield* Ref.make(0)
      let calls = 0
      const model = yield* LanguageModel.make({
        generateText: () => Effect.succeed([]),
        streamText: () => {
          calls += 1
          return calls === 1
            ? Stream.make(
                { type: "text-start" as const, id: "t1" },
                { type: "text-delta" as const, id: "t1", delta: "Partial response " },
              ).pipe(
                Stream.concat(Stream.never),
                Stream.ensuring(Ref.update(modelFinalizers, (count) => count + 1)),
              )
            : Stream.empty
        },
      })
      const h = yield* makeHarness(model, { interrupt: InterruptSignal.make({ steerQueue }) })

      yield* h.collect((event) =>
        event._tag === "TextDelta" ? Queue.offer(steerQueue, "Change direction") : Effect.void,
      )

      const journal = yield* Ref.get(h.journal)
      const assistantMsg = journal.find((event) => event._tag === "assistant/message")
      assert.ok(assistantMsg !== undefined && assistantMsg._tag === "assistant/message")
      assert.deepStrictEqual(assistantMsg.parts, [{ type: "text", text: "Partial response " }])
      assert.ok(
        journal.some(
          (event) => event._tag === "user/message" && event.content === "Change direction",
        ),
      )
      assert.strictEqual((yield* h.lastEvent("Finish"))?.reason, "completed")
      assert.strictEqual(yield* Ref.get(modelFinalizers), 1)
    }),
  )

  it.effect(
    "synthesizes reasoning-end when steered mid-stream with unclosed reasoning tokens",
    () =>
      Effect.gen(function* () {
        const steerQueue = yield* Queue.unbounded<string>()
        let calls = 0
        const model = yield* LanguageModel.make({
          generateText: () => Effect.succeed([]),
          streamText: () => {
            calls += 1
            return calls === 1
              ? Stream.make(
                  { type: "reasoning-start" as const, id: "r1" },
                  { type: "reasoning-delta" as const, id: "r1", delta: "Thinking deeply..." },
                ).pipe(Stream.concat(Stream.never))
              : Stream.empty
          },
        })
        const h = yield* makeHarness(model, { interrupt: InterruptSignal.make({ steerQueue }) })

        yield* h.collect((event) =>
          event._tag === "ReasoningDelta" ? Queue.offer(steerQueue, "Stop thinking") : Effect.void,
        )

        const journal = yield* Ref.get(h.journal)
        const assistantMsg = journal.find((event) => event._tag === "assistant/message")
        assert.ok(assistantMsg !== undefined && assistantMsg._tag === "assistant/message")
        assert.deepStrictEqual(assistantMsg.parts, [
          { type: "reasoning", text: "Thinking deeply..." },
        ])
        assert.strictEqual((yield* h.lastEvent("Finish"))?.reason, "completed")
      }),
  )

  it.effect("interrupts active tool execution when steered mid-tool", () =>
    Effect.gen(function* () {
      const sid = SessionId.make("run-steer-tool")
      const steerQueue = yield* Queue.unbounded<string>()
      const toolStarted = yield* Deferred.make<void>()
      const toolInterrupted = yield* Deferred.make<void>()
      const toolFinalizers = yield* Ref.make(0)

      const BlockingEcho: ErasedToolkit = {
        tools: { echo: Echo },
        handle: () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(toolStarted, undefined)
            return Stream.fromEffect(Effect.never).pipe(
              Stream.ensuring(Deferred.succeed(toolInterrupted, undefined)),
              Stream.ensuring(Ref.update(toolFinalizers, (count) => count + 1)),
            )
          }),
      }

      const model = yield* scripted([
        [{ type: "tool-call", id: "c1", name: "echo", params: { note: "hang" } }],
      ])
      const journal = yield* Ref.make<Array<SessionEvent>>([])
      const chat = yield* Chat.fromPrompt(Prompt.empty)

      const consumer = yield* Effect.forkChild(
        run({
          sessionId: sid,
          chat,
          model,
          toolkit: Effect.succeed(BlockingEcho),
          interrupt: InterruptSignal.make({ steerQueue }),
          append: (event) => Ref.update(journal, (all) => [...all, event]),
          hooks: hooksNoop,
        }).pipe(Stream.runDrain),
      )

      yield* Deferred.await(toolStarted)
      yield* Queue.offer(steerQueue, "Abort tool and do this")
      yield* Deferred.await(toolInterrupted)
      yield* Fiber.join(consumer)

      const events = yield* Ref.get(journal)
      assert.ok(events.some((event) => event._tag === "step/end" && event.reason === "interrupted"))
      assert.ok(
        events.some(
          (event) => event._tag === "user/message" && event.content === "Abort tool and do this",
        ),
      )
      assert.strictEqual(yield* Ref.get(toolFinalizers), 1)
    }),
  )

  it.effect("times out the complete model request stream", () =>
    Effect.gen(function* () {
      const model = yield* LanguageModel.make({
        generateText: () => Effect.succeed([]),
        streamText: () => Stream.never,
      })
      const h = yield* makeHarness(model, { policy: { modelTimeout: Duration.millis(20) } })
      const fiber = yield* Effect.forkChild(h.collect())
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
      const h = yield* makeHarness(model, {
        toolkit: {
          tools: { echo: Echo },
          handle: () => Effect.succeed(Stream.never),
        },
        policy: { toolTimeout: Duration.millis(20) },
      })
      const fiber = yield* Effect.forkChild(h.collect())
      yield* Effect.yieldNow
      yield* TestClock.adjust(Duration.millis(20))
      const exit = yield* Effect.exit(Fiber.join(fiber))
      assert.ok(Exit.isFailure(exit))
    }),
  )

  it.effect("records failed step and turn spans, emits Finish failed, and fails the stream", () =>
    Effect.gen(function* () {
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
      const h = yield* makeHarness(model)

      const exit = yield* Effect.exit(h.collect())
      assert.ok(Exit.isFailure(exit))

      const journal = yield* Ref.get(h.journal)
      assert.ok(journal.some((event) => event._tag === "step/end" && event.reason === "failed"))
      const last = journal[journal.length - 1]
      assert.ok(last !== undefined && last._tag === "turn/end" && last.reason === "failed")
    }),
  )

  it.effect("fails the stream when journal-span cleanup itself fails", () =>
    Effect.gen(function* () {
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
      const journal = yield* Ref.make<Array<SessionEvent>>([])
      const chat = yield* Chat.fromPrompt(Prompt.empty)
      const cleanupFailure = runError("journal broken", {
        sessionId: SessionId.make("run-cleanup"),
      })

      const exit = yield* Effect.exit(
        run({
          sessionId: SessionId.make("run-cleanup"),
          chat,
          model,
          toolkit: Effect.succeed(makeEchoToolkit()),
          interrupt: InterruptSignal.noop(),
          append: (event) =>
            event._tag === "step/end"
              ? Effect.fail(cleanupFailure)
              : Ref.update(journal, (all) => [...all, event]),
          hooks: hooksNoop,
        }).pipe(Stream.runDrain),
      )
      assert.ok(Exit.isFailure(exit))
      const events = yield* Ref.get(journal)
      assert.ok(events.every((event) => event._tag !== "turn/end"))
    }),
  )

  it.effect("bounds oversized encoded tool results and continues with a failed result", () =>
    Effect.gen(function* () {
      const model = yield* scripted([
        [{ type: "tool-call", id: "large", name: "echo", params: { note: "a long note" } }],
        [
          { type: "text-start", id: "t1" },
          { type: "text-end", id: "t1" },
        ],
      ])
      const h = yield* makeHarness(model, { policy: { maxToolOutputBytes: 8 } })

      yield* h.collect()

      const result = yield* h.lastEvent("ToolResult")
      assert.ok(result !== undefined)
      assert.strictEqual(result.isFailure, true)
      assert.deepStrictEqual(result.result, {
        type: "tool-output-too-large",
        message: "tool output exceeded 8 bytes",
      })
      assert.strictEqual((yield* h.lastEvent("Finish"))?.reason, "completed")
    }),
  )

  it.effect("journals the continuation prompt when turnStopping extends the turn", () =>
    Effect.gen(function* () {
      const continued = yield* Ref.make(false)
      const model = yield* scripted([
        [
          { type: "text-start", id: "t1" },
          { type: "text-end", id: "t1" },
        ],
        [
          { type: "text-start", id: "t2" },
          { type: "text-end", id: "t2" },
        ],
      ])
      const h = yield* makeHarness(model, {
        hooks: {
          ...hooksNoop,
          turnStopping: () =>
            Ref.modify(continued, (done) =>
              done ? [undefined, done] : [{ prompt: "go deeper" }, true],
            ),
        },
      })

      yield* h.collect()

      const journal = yield* Ref.get(h.journal)
      assert.ok(
        journal.some((event) => event._tag === "user/message" && event.content === "go deeper"),
      )
      assert.strictEqual(journal.filter((event) => event._tag === "turn/start").length, 2)
      assert.strictEqual((yield* h.lastEvent("Finish"))?.reason, "completed")
    }),
  )

  it.effect("adopts a steer that lands while turnStopping is pending", () =>
    Effect.gen(function* () {
      const steerQueue = yield* Queue.unbounded<string>()
      const firstStop = yield* Ref.make(true)
      const steerArmed = yield* Ref.make(true)
      const model = yield* scripted([
        [{ type: "text-delta", id: "t1", delta: "turn one" }],
        [
          { type: "text-start", id: "t2" },
          { type: "text-end", id: "t2" },
        ],
      ])
      const h = yield* makeHarness(model, {
        interrupt: InterruptSignal.make({ steerQueue }),
        hooks: {
          ...hooksNoop,
          // Only the steer can end turn one; later turns stop normally.
          turnStopping: () =>
            Ref.getAndUpdate(firstStop, () => false).pipe(
              Effect.flatMap((first) => (first ? Effect.never : Effect.as(Effect.void, undefined))),
            ),
        },
        // Arm the steer once the first step completes, before turnStopping runs.
        onJournal: (event) =>
          event._tag === "step/end"
            ? Ref.modify(steerArmed, (armed) => [armed, false]).pipe(
                Effect.flatMap((armed) =>
                  armed ? Queue.offer(steerQueue, "pivot").pipe(Effect.asVoid) : Effect.void,
                ),
              )
            : Effect.void,
      })

      yield* h.collect()

      const journal = yield* Ref.get(h.journal)
      assert.ok(journal.some((event) => event._tag === "user/message" && event.content === "pivot"))
      assert.ok(
        journal.some((event) => event._tag === "turn/end" && event.reason === "interrupted"),
      )
      assert.strictEqual((yield* h.lastEvent("Finish"))?.reason, "completed")
    }),
  )

  it.effect("finishes stopped without another turn when the policy limit is reached", () =>
    Effect.gen(function* () {
      const model = yield* scripted([
        [
          { type: "text-start", id: "t1" },
          { type: "text-end", id: "t1" },
        ],
      ])
      const h = yield* makeHarness(model, {
        policy: { maxTurns: 1 },
        hooks: {
          ...hooksNoop,
          turnStopping: () => Effect.succeed({ prompt: "one more" }),
        },
      })

      yield* h.collect()

      assert.strictEqual((yield* h.lastEvent("Finish"))?.reason, "stopped")
      const journal = yield* Ref.get(h.journal)
      assert.strictEqual(journal.filter((event) => event._tag === "turn/start").length, 1)
      assert.ok(journal.some((event) => event._tag === "turn/end" && event.reason === "completed"))
    }),
  )

  it.effect("closes journal spans and finishes interrupted when the consumer drops the run", () =>
    Effect.gen(function* () {
      const model = yield* LanguageModel.make({
        generateText: () => Effect.succeed([]),
        streamText: () =>
          Stream.make({ type: "text-start" as const, id: "t1" }).pipe(Stream.concat(Stream.never)),
      })
      const requestStarted = yield* Deferred.make<void>()
      const journal = yield* Ref.make<Array<SessionEvent>>([])
      const chat = yield* Chat.fromPrompt(Prompt.empty)

      const consumer = yield* Effect.forkChild(
        run({
          sessionId: SessionId.make("run-drop"),
          chat,
          model,
          toolkit: Effect.succeed(makeEchoToolkit()),
          interrupt: InterruptSignal.noop(),
          append: (event) =>
            Ref.update(journal, (all) => [...all, event]).pipe(
              Effect.andThen(
                event._tag === "model/request"
                  ? Deferred.succeed(requestStarted, undefined)
                  : Effect.void,
              ),
            ),
          hooks: hooksNoop,
        }).pipe(Stream.runDrain),
      )

      yield* Deferred.await(requestStarted)
      yield* Fiber.interrupt(consumer)

      const events = yield* Ref.get(journal)
      assert.ok(events.some((event) => event._tag === "step/end" && event.reason === "interrupted"))
      const last = events[events.length - 1]
      assert.ok(last !== undefined && last._tag === "turn/end" && last.reason === "interrupted")
    }),
  )
})
