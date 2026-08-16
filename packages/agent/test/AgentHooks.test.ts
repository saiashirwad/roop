import { assert, it } from "@effect/vitest"
import { Effect, Layer, Ref, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/unstable/ai"

import { Agent, AgentLiveToolkit } from "../src/Agent.ts"
import {
  layerHook,
  layerNoop,
  StepRejected,
  ToolRejected,
  type AgentHooksInterface,
  type ContinueTurn,
  type StopRequest,
  type RunContext,
} from "../src/AgentHooks.ts"
import { AgentHooks } from "../src/AgentHooks.ts"
import { cryptoWeb } from "../src/cryptoWeb.ts"
import { SessionJournalMemory } from "../src/SessionJournal.ts"
import { scripted } from "../src/Testing.ts"

const Echo = Tool.make("echo", {
  description: "echo a note back",
  parameters: Schema.Struct({ note: Schema.String }),
  success: Schema.Struct({ reply: Schema.String }),
})

const EchoToolkit = Toolkit.make(Echo)

const modelLayer = (model: Effect.Effect<LanguageModel.Service>) =>
  Layer.effect(LanguageModel.LanguageModel, model)

const Main = (
  model: Effect.Effect<LanguageModel.Service>,
  hooks?: Layer.Layer<AgentHooks, never, never>,
) => {
  const base = AgentLiveToolkit(EchoToolkit, {
    models: [{ id: "fake", provider: "test", layer: modelLayer(model) }],
  }).pipe(
    Layer.provide(SessionJournalMemory),
    Layer.provide(cryptoWeb),
    Layer.provide(
      EchoToolkit.toLayer({
        echo: ({ note }) => Effect.succeed({ reply: note }),
      }),
    ),
  )
  return hooks === undefined ? base : base.pipe(Layer.provide(hooks))
}

const collect = <A, E = never, R = never>(stream: Stream.Stream<A, E, R>) =>
  Stream.runCollect(stream).pipe(Effect.map((chunk) => [...chunk]))

const tags = (events: ReadonlyArray<any>) => events.map((event) => event._tag)

it.layer(
  Main(
    scripted([
      [{ type: "tool-call" as const, id: "c1", name: "echo", params: { note: "hi" } }],
      [
        { type: "text-start" as const, id: "t1" },
        { type: "text-delta" as const, id: "t1", delta: "done" },
        { type: "text-end" as const, id: "t1" },
      ],
    ]),
  ),
)("turn and step boundaries", (it) => {
  it.effect("records durable turn/step events with end reasons", () =>
    Effect.gen(function* () {
      const agent = yield* Agent
      const events = yield* collect(agent.prompt({ prompt: "say hi", sessionId: "s1" }))
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      assert.strictEqual((events[events.length - 1] as any).reason, "completed")

      const session = yield* agent.history("s1")
      assert.deepStrictEqual(tags(session.events), [
        "user/message",
        "turn/start",
        "step/start",
        "model/request",
        "tool/call",
        "tool/result",
        "step/end",
        "step/start",
        "model/request",
        "assistant/message",
        "step/end",
        "turn/end",
      ])
      /* SAFETY: The fixture's final event is the turn/end record with a reason. */
      const turnEnd = session.events[session.events.length - 1] as any
      assert.strictEqual(turnEnd.reason, "completed")
      /* SAFETY: The recorded step/start event is present in the fixture's ordered history. */
      assert.strictEqual(
        (session.events.find((event) => event._tag === "step/start") as any).index,
        1,
      )
    }),
  )
})

it.layer(
  Main(
    scripted([
      [
        {
          type: "tool-call" as const,
          id: "provider-1",
          name: "echo",
          params: { note: "hi" },
          providerExecuted: true,
        },
        {
          type: "tool-result" as const,
          id: "provider-1",
          name: "echo",
          isFailure: false,
          result: { reply: "provider" },
          providerExecuted: true,
        },
      ],
      [{ type: "text-delta" as const, id: "done", delta: "done" }],
    ]),
  ),
)("provider-executed tool calls", (it) => {
  it.effect("preserves providerExecuted in emitted and durable events", () =>
    Effect.gen(function* () {
      const agent = yield* Agent
      const events = yield* collect(agent.prompt({ prompt: "say hi", sessionId: "provider" }))
      /* SAFETY: The scripted response emits the call and result first. */
      assert.strictEqual((events[0] as any).providerExecuted, true)
      /* SAFETY: The scripted response emits the call and result first. */
      assert.strictEqual((events[1] as any).providerExecuted, true)

      const session = yield* agent.history("provider")
      /* SAFETY: The scripted response contains a durable tool call. */
      const call = session.events.find((event) => event._tag === "tool/call") as any
      assert.strictEqual(call.providerExecuted, true)
      /* SAFETY: The scripted response contains a durable tool result. */
      const result = session.events.find((event) => event._tag === "tool/result") as any
      assert.strictEqual(result.providerExecuted, true)
    }),
  )
})

it.layer(
  Main(
    scripted([
      [{ type: "tool-call" as const, id: "c1", name: "echo", params: { note: "one" } }],
      [{ type: "tool-call" as const, id: "c2", name: "echo", params: { note: "two" } }],
      [{ type: "tool-call" as const, id: "c3", name: "echo", params: { note: "three" } }],
    ]),
  ),
)("step cap", (it) => {
  it.effect("marks the turn stopped when the step cap is hit", () =>
    Effect.gen(function* () {
      const agent = yield* Agent
      const events = yield* collect(
        agent.prompt({ prompt: "go", sessionId: "s2", policy: { maxTotalSteps: 2 } }),
      )
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      assert.strictEqual((events[events.length - 1] as any).reason, "stopped")

      const session = yield* agent.history("s2")
      assert.deepStrictEqual(tags(session.events), [
        "user/message",
        "turn/start",
        "step/start",
        "model/request",
        "tool/call",
        "tool/result",
        "step/end",
        "step/start",
        "model/request",
        "tool/call",
        "tool/result",
        "step/end",
        "turn/end",
      ])
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      const turnEnd = session.events[session.events.length - 1] as any
      assert.strictEqual(turnEnd.reason, "stopped")
    }),
  )
})

const deniedResults = Ref.makeUnsafe<Array<readonly [string, boolean]>>([])

it.layer(
  Main(
    scripted([
      [{ type: "tool-call" as const, id: "c1", name: "echo", params: { note: "hi" } }],
      [{ type: "text-delta" as const, id: "t1", delta: "done" }],
    ]),
    layerHook("gate", (downstream) =>
      Effect.succeed({
        ...downstream,
        beforeToolExecute: (context, call) =>
          call.name === "echo"
            ? Effect.fail(new ToolRejected({ reason: "echo is not allowed here" }))
            : downstream.beforeToolExecute(context, call),
        afterToolExecute: (context, call, isFailure) =>
          Ref.update(deniedResults, (results) => [
            ...results,
            [call.name, isFailure] as const,
          ]).pipe(Effect.andThen(downstream.afterToolExecute(context, call, isFailure))),
      }),
    ).pipe(Layer.provide(layerNoop)),
  ),
)("beforeToolExecute rejection", (it) => {
  it.effect("surfaces a rejection as a failed tool result without breaking the loop", () =>
    Effect.gen(function* () {
      const agent = yield* Agent
      yield* Ref.set(deniedResults, [])
      const events = yield* collect(agent.prompt({ prompt: "say hi", sessionId: "s3" }))

      assert.deepStrictEqual(tags(events), ["ToolCall", "ToolResult", "TextDelta", "Finish"])
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      const result = events[1] as any
      assert.strictEqual(result.isFailure, true)
      assert.deepStrictEqual(result.result, {
        type: "execution-denied",
        reason: "echo is not allowed here",
      })
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      assert.strictEqual((events[3] as any).reason, "completed")

      const session = yield* agent.history("s3")
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      const durable = session.events.find((event) => event._tag === "tool/result") as any
      assert.strictEqual(durable.isFailure, true)
      assert.deepStrictEqual(durable.result, {
        type: "execution-denied",
        reason: "echo is not allowed here",
      })
      assert.deepStrictEqual(yield* Ref.get(deniedResults), [["echo", true]])
    }),
  )
})

const modelPrompts = Ref.makeUnsafe<Array<ReadonlyArray<unknown>>>([])

it.layer(
  Main(
    scripted(
      [
        [
          { type: "text-start" as const, id: "t1" },
          { type: "text-delta" as const, id: "t1", delta: "done" },
          { type: "text-end" as const, id: "t1" },
        ],
      ],
      modelPrompts,
    ),
    layerHook("compaction", (downstream) =>
      Effect.succeed({
        ...downstream,
        beforeRequest: (context, request) =>
          downstream.beforeRequest(context, {
            ...request,
            prompt: [Prompt.makeMessage("system", { content: "summary of everything so far" })],
          }),
      }),
    ).pipe(Layer.provide(layerNoop)),
  ),
)("beforeRequest rewrite", (it) => {
  it.effect("reaches the model and is recorded alongside the full durable history", () =>
    Effect.gen(function* () {
      const agent = yield* Agent
      yield* Ref.set(modelPrompts, [])
      const events = yield* collect(agent.prompt({ prompt: "say hi", sessionId: "s4" }))
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      assert.strictEqual((events[events.length - 1] as any).reason, "completed")

      const seen = yield* Ref.get(modelPrompts)
      assert.strictEqual(seen.length, 1)
      assert.deepStrictEqual(seen[0], [
        Prompt.makeMessage("system", { content: "summary of everything so far" }),
      ])

      const session = yield* agent.history("s4")
      assert.deepStrictEqual(tags(session.events), [
        "user/message",
        "turn/start",
        "step/start",
        "model/request",
        "assistant/message",
        "step/end",
        "turn/end",
      ])
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      const request = session.events.find((event) => event._tag === "model/request") as any
      assert.deepStrictEqual(request.request.prompt, [
        Prompt.makeMessage("system", { content: "summary of everything so far" }),
      ])
    }),
  )
})

const recording = (name: string, order: Ref.Ref<Array<string>>) =>
  layerHook(name, (downstream) =>
    Effect.succeed({
      ...downstream,
      beforeRequest: (context, request) =>
        Effect.gen(function* () {
          yield* Ref.update(order, (entries) => [...entries, `${name}:in`])
          const result = yield* downstream.beforeRequest(context, request)
          yield* Ref.update(order, (entries) => [...entries, `${name}:out`])
          return result
        }),
    }),
  )

it("layerHook composes outermost-first via Layer.provide", () =>
  Effect.gen(function* () {
    const order = yield* Ref.make<Array<string>>([])
    const program = Effect.gen(function* () {
      const hooks = yield* AgentHooks
      return yield* Effect.all([
        hooks.beforeRequest({ sessionId: "s", turn: 1, step: 1 }, { prompt: [] }),
        Ref.get(order),
      ])
    })
    const layer = recording("outer", order).pipe(
      Layer.provide(recording("inner", order)),
      Layer.provide(layerNoop),
    )
    const [, entries] = yield* Effect.provide(program, layer)
    assert.deepStrictEqual(entries, ["outer:in", "inner:in", "inner:out", "outer:out"])
  }).pipe(Effect.runPromise))

it.layer(
  Main(
    scripted([
      [
        { type: "text-start" as const, id: "t1" },
        { type: "text-delta" as const, id: "t1", delta: "one" },
        { type: "text-end" as const, id: "t1" },
      ],
      [
        { type: "text-start" as const, id: "t2" },
        { type: "text-delta" as const, id: "t2", delta: "two" },
        { type: "text-end" as const, id: "t2" },
      ],
    ]),
    layerHook("continue", (downstream) =>
      Effect.gen(function* () {
        let asked = false
        const hooks: AgentHooksInterface = {
          ...downstream,
          turnStopping: (context: RunContext, stop: StopRequest) => {
            if (asked || stop.reason !== "completed") return downstream.turnStopping(context, stop)
            asked = true
            return Effect.succeed<ContinueTurn>({ prompt: "keep going" })
          },
        }
        return hooks
      }),
    ).pipe(Layer.provide(layerNoop)),
  ),
)("turnStopping continuation", (it) => {
  it.effect("a continuation journals a user message and drives another turn", () =>
    Effect.gen(function* () {
      const agent = yield* Agent
      const events = yield* collect(agent.prompt({ prompt: "begin", sessionId: "s7" }))
      assert.deepStrictEqual(tags(events), ["TextDelta", "TextDelta", "Finish"])
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      assert.strictEqual((events[2] as any).reason, "completed")

      const session = yield* agent.history("s7")
      assert.deepStrictEqual(tags(session.events), [
        "user/message",
        "turn/start",
        "step/start",
        "model/request",
        "assistant/message",
        "step/end",
        "turn/end",
        "user/message",
        "turn/start",
        "step/start",
        "model/request",
        "assistant/message",
        "step/end",
        "turn/end",
      ])
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      const continuation = session.events[7] as any
      assert.strictEqual(continuation.content, "keep going")
    }),
  )
})

it.layer(
  Main(
    scripted([]),
    layerHook("reject-step", (downstream) =>
      Effect.succeed({
        ...downstream,
        preStep: () => Effect.fail(new StepRejected({ message: "claim rejected" })),
      }),
    ).pipe(Layer.provide(layerNoop)),
  ),
)("preStep failure", (it) => {
  it.effect("closes the started step and turn as failed", () =>
    Effect.gen(function* () {
      const agent = yield* Agent
      const events = yield* collect(agent.prompt({ prompt: "begin", sessionId: "s8" }))
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      assert.strictEqual((events[events.length - 1] as any).reason, "failed")

      const session = yield* agent.history("s8")
      assert.deepStrictEqual(tags(session.events), [
        "user/message",
        "turn/start",
        "step/start",
        "step/end",
        "turn/end",
      ])
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      const stepEnd = session.events[3] as any
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      const turnEnd = session.events[4] as any
      assert.strictEqual(stepEnd.reason, "failed")
      assert.strictEqual(turnEnd.reason, "failed")
      assert.match(stepEnd.message, /claim rejected/)
      assert.match(turnEnd.message, /claim rejected/)
    }),
  )
})
