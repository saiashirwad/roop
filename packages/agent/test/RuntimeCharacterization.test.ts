import { assert, it } from "@effect/vitest"
import { Deferred, Duration, Effect, Exit, Fiber, Ref, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { AiError, LanguageModel, Tool } from "effect/unstable/ai"

import { Agent } from "../src/Agent.ts"
import { JournalMemory } from "../src/JournalMemory.ts"
import { Module } from "../src/Module.ts"
import { runAgent } from "../src/Runtime.ts"

const completeAfterTool = (toolCall: { readonly name: string; readonly params: unknown }) => {
  let calls = 0
  return LanguageModel.make({
    generateText: () => Effect.succeed([]),
    streamText: () => {
      calls += 1
      return calls === 1
        ? Stream.make({ type: "tool-call" as const, id: "call", ...toolCall })
        : Stream.make({ type: "text-delta" as const, id: "done", delta: "done" })
    },
  })
}

it.effect("streams reasoning as a live event", () =>
  Effect.gen(function* () {
    const model = yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () =>
        Stream.fromIterable([
          { type: "reasoning-start" as const, id: "reasoning" },
          { type: "reasoning-delta" as const, id: "reasoning", delta: "think" },
          { type: "reasoning-end" as const, id: "reasoning" },
          { type: "text-delta" as const, id: "answer", delta: "answer" },
        ]),
    })
    const events = yield* runAgent(Agent.make("reasoning", Module.empty), {
      sessionId: "reasoning",
      prompt: "reason",
    }).pipe(
      Stream.runCollect,
      Effect.provide(JournalMemory),
      Effect.provideService(LanguageModel.LanguageModel, model),
    )

    assert.ok(events.some((event) => event._tag === "ReasoningDelta" && event.delta === "think"))
  }),
)

it.effect("fails a model request after its total timeout", () =>
  Effect.gen(function* () {
    const model = yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () => Stream.never,
    })
    const fiber = yield* runAgent(Agent.make("model-timeout", Module.empty), {
      sessionId: "model-timeout",
      prompt: "wait",
      policy: { modelTimeout: Duration.millis(20) },
    }).pipe(
      Stream.runDrain,
      Effect.provide(JournalMemory),
      Effect.provideService(LanguageModel.LanguageModel, model),
      Effect.forkChild,
    )
    yield* Effect.yieldNow
    yield* TestClock.adjust(Duration.millis(20))
    assert.ok(Exit.isFailure(yield* Effect.exit(Fiber.join(fiber))))
  }),
)

it.effect("turns a tool timeout into one model-visible failed result", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const Slow = Tool.make("slow_timeout", {
      parameters: Schema.Struct({}),
      success: Schema.String,
    })
    const model = yield* completeAfterTool({ name: "slow_timeout", params: {} })
    const fiber = yield* runAgent(
      Agent.make(
        "tool-timeout",
        Module.tool(Slow, () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
        ),
      ),
      {
        sessionId: "tool-timeout",
        prompt: "wait",
        policy: { toolTimeout: Duration.millis(20) },
      },
    ).pipe(
      Stream.runCollect,
      Effect.provide(JournalMemory),
      Effect.provideService(LanguageModel.LanguageModel, model),
      Effect.forkChild,
    )
    yield* Deferred.await(started)
    yield* TestClock.adjust(Duration.millis(20))
    const events = yield* Fiber.join(fiber)
    const failures = events.filter((event) => event._tag === "ToolResult" && event.isFailure)
    assert.strictEqual(failures.length, 1)
    assert.match(JSON.stringify(failures[0]), /tool-timeout/)
  }),
)

it.effect("bounds encoded tool output and continues the run", () =>
  Effect.gen(function* () {
    const Large = Tool.make("large_output", {
      parameters: Schema.Struct({}),
      success: Schema.String,
    })
    const model = yield* completeAfterTool({ name: "large_output", params: {} })
    const events = yield* runAgent(
      Agent.make(
        "large-output",
        Module.tool(Large, () => Effect.succeed("too large")),
      ),
      {
        sessionId: "large-output",
        prompt: "run",
        policy: { maxToolOutputBytes: 2 },
      },
    ).pipe(
      Stream.runCollect,
      Effect.provide(JournalMemory),
      Effect.provideService(LanguageModel.LanguageModel, model),
    )
    const result = events.find((event) => event._tag === "ToolResult")
    assert.ok(result?._tag === "ToolResult" && result.isFailure)
    if (result?._tag === "ToolResult") {
      assert.match(JSON.stringify(result.result), /tool-output-too-large/)
    }
  }),
)

it.effect("holds a scheduler permit for the full tool lifetime", () =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>()
    const firstStarted = yield* Deferred.make<void>()
    const active = yield* Ref.make(0)
    const maximum = yield* Ref.make(0)
    const Concurrent = Tool.make("concurrent", {
      parameters: Schema.Struct({ id: Schema.String }),
      success: Schema.String,
    })
    const agent = Agent.make(
      "concurrency",
      Module.tool(Concurrent, ({ id }) =>
        Effect.gen(function* () {
          const count = yield* Ref.updateAndGet(active, (value) => value + 1)
          yield* Ref.update(maximum, (value) => Math.max(value, count))
          if (id === "first") yield* Deferred.succeed(firstStarted, undefined)
          yield* Deferred.await(release)
          return id
        }).pipe(Effect.ensuring(Ref.update(active, (value) => value - 1))),
      ),
    )
    let modelCalls = 0
    const model = yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () => {
        modelCalls += 1
        return modelCalls === 1
          ? Stream.fromIterable([
              {
                type: "tool-call" as const,
                id: "first",
                name: "concurrent",
                params: { id: "first" },
              },
              {
                type: "tool-call" as const,
                id: "second",
                name: "concurrent",
                params: { id: "second" },
              },
            ])
          : Stream.make({ type: "text-delta" as const, id: "done", delta: "done" })
      },
    })
    const fiber = yield* runAgent(agent, {
      sessionId: "concurrency",
      prompt: "run both",
      policy: { toolConcurrency: 1 },
    }).pipe(
      Stream.runCollect,
      Effect.provide(JournalMemory),
      Effect.provideService(LanguageModel.LanguageModel, model),
      Effect.forkChild,
    )
    yield* Deferred.await(firstStarted)
    yield* Effect.yieldNow
    assert.strictEqual(yield* Ref.get(active), 1)
    yield* Deferred.succeed(release, undefined)
    const events = yield* Fiber.join(fiber)
    assert.strictEqual(yield* Ref.get(maximum), 1)
    assert.strictEqual(events.filter((event) => event._tag === "ToolResult").length, 2)
  }),
)

it.effect("stops an endless tool loop at step and total-step limits", () =>
  Effect.gen(function* () {
    const Loop = Tool.make("loop", { parameters: Schema.Struct({}), success: Schema.String })
    for (const [sessionId, policy, expectedCalls] of [
      ["step-limit", { maxStepsPerTurn: 2, maxTotalSteps: 10 }, 2],
      ["total-limit", { maxStepsPerTurn: 10, maxTotalSteps: 1 }, 1],
    ] as const) {
      let calls = 0
      const model = yield* LanguageModel.make({
        generateText: () => Effect.succeed([]),
        streamText: () => {
          calls += 1
          return Stream.make({
            type: "tool-call" as const,
            id: `call-${calls}`,
            name: "loop",
            params: {},
          })
        },
      })
      const events = yield* runAgent(
        Agent.make(
          "limits",
          Module.tool(Loop, () => Effect.succeed("again")),
        ),
        { sessionId, prompt: "loop", policy },
      ).pipe(
        Stream.runCollect,
        Effect.provide(JournalMemory),
        Effect.provideService(LanguageModel.LanguageModel, model),
      )
      assert.strictEqual(calls, expectedCalls)
      assert.ok(events.some((event) => event._tag === "Finish" && event.reason === "stopped"))
    }
  }),
)

it.effect("keeps invalid tool parameters as a typed Effect AI failure", () =>
  Effect.gen(function* () {
    const Strict = Tool.make("strict", {
      parameters: Schema.Struct({ id: Schema.String }),
      success: Schema.String,
    })
    const model = yield* completeAfterTool({ name: "strict", params: { id: 42 } })
    const exit = yield* Effect.exit(
      runAgent(
        Agent.make(
          "invalid-params",
          Module.tool(Strict, ({ id }) => Effect.succeed(id)),
        ),
        { sessionId: "invalid-params", prompt: "run" },
      ).pipe(
        Stream.runCollect,
        Effect.provide(JournalMemory),
        Effect.provideService(LanguageModel.LanguageModel, model),
      ),
    )
    assert.ok(Exit.isFailure(exit))
    const error = Exit.findErrorOption(exit)
    assert.ok(error._tag === "Some")
    if (error._tag === "Some") assert.ok(Schema.is(AiError.AiError)(error.value))
  }),
)
