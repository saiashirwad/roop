import { assert, it } from "@effect/vitest"
import { Duration, Effect, Layer, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { LanguageModel, type Response, Tool } from "effect/unstable/ai"

import { Agent } from "../src/Agent.ts"
import type { JournalEvent, Usage } from "../src/Event.ts"
import { Journal, type JournalLoadError } from "../src/Journal.ts"
import { JournalMemory } from "../src/JournalMemory.ts"
import { Module } from "../src/Module.ts"
import { isLive, isTerminal, RunEmit, type RunEvent } from "../src/RunEvent.ts"
import { AgentRuntimeLive, runAgent } from "../src/Runtime.ts"
import { scripted } from "../src/Testing.ts"

const Work = Tool.make("work", {
  parameters: Schema.Struct({ id: Schema.String }),
  success: Schema.String,
})

const finish = (
  inputTokens: number,
  outputTokens: number,
  extra?: { readonly cacheRead?: number; readonly reasoning?: number },
): Response.StreamPartEncoded => ({
  type: "finish",
  reason: "stop",
  usage: {
    inputTokens: {
      total: inputTokens,
      uncached: inputTokens - (extra?.cacheRead ?? 0),
      cacheRead: extra?.cacheRead,
      cacheWrite: undefined,
    },
    outputTokens: { total: outputTokens, text: outputTokens, reasoning: extra?.reasoning },
  },
  response: undefined,
})

const metadata = (modelId: string): Response.StreamPartEncoded => ({
  type: "response-metadata",
  id: undefined,
  modelId,
  timestamp: undefined,
  request: undefined,
})

const collect = <E, R>(
  stream: Stream.Stream<RunEvent, E, R>,
  sessionId: string,
): Effect.Effect<
  { readonly live: ReadonlyArray<RunEvent>; readonly stored: ReadonlyArray<JournalEvent> },
  E | JournalLoadError,
  R | Journal
> =>
  Effect.gen(function* () {
    const live = yield* Stream.runCollect(stream)
    const stored = (yield* (yield* Journal).load(sessionId)).events
    return { live: [...live], stored }
  })

it.effect("stamps every event with the clock at commit time", () =>
  Effect.gen(function* () {
    const model = yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () =>
        Stream.unwrap(
          TestClock.adjust(Duration.millis(10)).pipe(
            Effect.as(
              Stream.fromIterable<Response.StreamPartEncoded>([
                { type: "text-delta", id: "t", delta: "hi" },
              ]),
            ),
          ),
        ),
    })
    yield* TestClock.adjust(Duration.millis(1_000))
    const { live, stored } = yield* collect(
      runAgent(Agent.make("clock", Module.empty), { sessionId: "clock", prompt: "now" }),
      "clock",
    ).pipe(Effect.provide(JournalMemory), Effect.provideService(LanguageModel.LanguageModel, model))

    const at = live.map((event) => event.at)
    assert.strictEqual(live[0]?._tag, "user/message")
    assert.strictEqual(live[0]?.at, 1_000)
    const delta = live.find((event) => event._tag === "text/delta")
    assert.strictEqual(delta?.at, 1_010)
    const terminal = live.find(isTerminal)
    assert.strictEqual(terminal?.at, 1_010)
    assert.ok(at.every((time, index) => index === 0 || time >= at[index - 1]!))
    assert.deepStrictEqual(
      stored.map((event) => event.at),
      live.filter((event) => !isLive(event)).map((event) => event.at),
    )
  }),
)

it.effect("records usage per attempt and sums it onto step and run", () =>
  Effect.gen(function* () {
    const model = yield* scripted([
      [
        metadata("fake-1"),
        { type: "tool-call", id: "c1", name: "work", params: { id: "a" } },
        finish(100, 20, { cacheRead: 40 }),
      ],
      [
        metadata("fake-1"),
        { type: "text-delta", id: "t", delta: "done" },
        finish(150, 30, { reasoning: 5 }),
      ],
    ])
    const agent = Agent.make(
      "usage",
      Module.tool(Work, () => Effect.succeed("worked")),
    )
    const { live, stored } = yield* collect(
      runAgent(agent, { sessionId: "usage", prompt: "go" }),
      "usage",
    ).pipe(Effect.provide(JournalMemory), Effect.provideService(LanguageModel.LanguageModel, model))

    const attempts = stored.filter(
      (event) => event._tag === "model/attempt" && event.state === "completed",
    )
    assert.deepStrictEqual(
      attempts.map((event) =>
        event._tag === "model/attempt" ? [event.model, event.finishReason, event.usage] : [],
      ),
      [
        [
          "fake-1",
          "stop",
          { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 40 },
        ],
        [
          "fake-1",
          "stop",
          { inputTokens: 150, outputTokens: 30, totalTokens: 180, reasoningTokens: 5 },
        ],
      ],
    )
    const steps = stored.filter((event) => event._tag === "step" && event.state === "completed")
    assert.deepStrictEqual(
      steps.map((event) => (event._tag === "step" ? event.usage : undefined)),
      [
        { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedInputTokens: 40 },
        { inputTokens: 150, outputTokens: 30, totalTokens: 180, reasoningTokens: 5 },
      ],
    )
    const expected: Usage = {
      inputTokens: 250,
      outputTokens: 50,
      totalTokens: 300,
      cachedInputTokens: 40,
      reasoningTokens: 5,
    }
    const terminal = live.find(isTerminal)
    assert.ok(terminal?._tag === "run")
    if (terminal?._tag === "run") assert.deepStrictEqual(terminal.usage, expected)
    const result = yield* Agent.run(agent, { sessionId: "usage-result", prompt: "go" }).pipe(
      Effect.provide(JournalMemory),
      Effect.provideService(
        LanguageModel.LanguageModel,
        yield* scripted([[{ type: "text-delta", id: "t", delta: "x" }, finish(7, 3)]]),
      ),
    )
    assert.deepStrictEqual(result.usage, { inputTokens: 7, outputTokens: 3, totalTokens: 10 })
  }),
)

it.effect("reports an empty usage when the model never sends a finish part", () =>
  Effect.gen(function* () {
    const model = yield* scripted([[{ type: "text-delta", id: "t", delta: "x" }]])
    const { stored } = yield* collect(
      runAgent(Agent.make("no-finish", Module.empty), { sessionId: "no-finish", prompt: "go" }),
      "no-finish",
    ).pipe(Effect.provide(JournalMemory), Effect.provideService(LanguageModel.LanguageModel, model))
    const attempt = stored.find(
      (event) => event._tag === "model/attempt" && event.state === "completed",
    )
    assert.ok(attempt?._tag === "model/attempt")
    if (attempt?._tag === "model/attempt") {
      assert.strictEqual(attempt.usage, undefined)
      assert.strictEqual(attempt.model, undefined)
    }
    const run = stored.find(isTerminal)
    assert.ok(run?._tag === "run")
    if (run?._tag === "run") {
      assert.deepStrictEqual(run.usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 })
    }
  }),
)

it.effect("streams preliminary tool results and handler output as tool/output", () =>
  Effect.gen(function* () {
    const model = yield* scripted([
      [{ type: "tool-call", id: "c1", name: "work", params: { id: "a" } }],
      [{ type: "text-delta", id: "t", delta: "done" }],
    ])
    const agent = Agent.make({
      name: "streaming-tool",
      tools: [
        Agent.tool(Work, ({ id }, context) =>
          Effect.gen(function* () {
            yield* context.preliminary(`starting ${id}`)
            const emit = yield* RunEmit
            yield* emit.output({ progress: 50 })
            return `finished ${id}`
          }),
        ),
      ],
    })
    const { live, stored } = yield* collect(
      runAgent(agent, { sessionId: "streaming-tool", prompt: "go" }),
      "streaming-tool",
    ).pipe(Effect.provide(JournalMemory), Effect.provideService(LanguageModel.LanguageModel, model))

    const outputs = live.filter((event) => event._tag === "tool/output")
    assert.deepStrictEqual(
      outputs.map((event) => (event._tag === "tool/output" ? [event.name, event.output] : [])),
      [
        ["work", { progress: 50 }],
        ["work", "starting a"],
      ],
    )
    assert.ok(outputs.every((event) => event._tag === "tool/output" && event.step === 1))
    const results = live.filter((event) => event._tag === "tool/result")
    assert.strictEqual(results.length, 1)
    assert.ok(results[0]?._tag === "tool/result" && results[0].result === "finished a")
    assert.ok(
      stored.every((event) => event._tag !== "tool/result" || event.result === "finished a"),
    )
    assert.strictEqual(stored.filter((event) => event._tag === "tool/result").length, 1)
  }),
)

it.effect("forwards a child's run events wrapped as subagent under the tool call", () =>
  Effect.gen(function* () {
    const child = Agent.make({ name: "child", instructions: "Answer." })
    const parent = Agent.make({
      name: "parent",
      tools: [
        Agent.delegate(child, {
          name: "ask",
          parameters: Schema.Struct({ prompt: Schema.String }),
          prompt: ({ prompt }) => prompt,
        }),
      ],
    })
    const model = yield* scripted([
      [{ type: "tool-call", id: "c1", name: "ask", params: { prompt: "hello" } }],
      [{ type: "text-delta", id: "t", delta: "child says hi" }],
      [{ type: "text-delta", id: "t", delta: "parent done" }],
    ])
    const { live } = yield* collect(
      Agent.events(parent, { sessionId: "forwarding", prompt: "go" }),
      "forwarding",
    ).pipe(
      Effect.provide(Layer.mergeAll(JournalMemory, AgentRuntimeLive)),
      Effect.provideService(LanguageModel.LanguageModel, model),
    )
    const forwarded = live.filter((event) => event._tag === "subagent")
    assert.ok(forwarded.length > 0)
    const innerTags = forwarded.map((event) => (event._tag === "subagent" ? event.event._tag : ""))
    assert.ok(innerTags.includes("run"))
    assert.ok(innerTags.includes("text/delta"))
    assert.ok(
      forwarded.every(
        (event) =>
          event._tag === "subagent" && event.name === "child" && event.toolCallId !== undefined,
      ),
    )
    const childTerminal = forwarded.find(
      (event) => event._tag === "subagent" && isTerminal(event.event),
    )
    assert.ok(childTerminal !== undefined)
    // The wrapper is not a terminal event of the parent run.
    assert.ok(!isTerminal(childTerminal))
  }),
)
