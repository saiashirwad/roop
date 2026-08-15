import { NodeFileSystem } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { Effect, Exit, Fiber, FileSystem, Layer, Option, Queue, Ref, Schema, Stream } from "effect"
import { LanguageModel, Response, Tool, Toolkit } from "effect/unstable/ai"

import { Agent, AgentLiveToolkit } from "../src/Agent.ts"
import { delegation } from "../src/agentTool.ts"
import { cryptoWeb } from "../src/cryptoWeb.ts"
import { deriveMessages } from "../src/SessionEvent.ts"
import { SessionStoreFs, SessionStoreMemory } from "../src/SessionStore.ts"

const Echo = Tool.make("echo", {
  description: "echo a note back",
  parameters: Schema.Struct({ note: Schema.String }),
  success: Schema.Struct({ reply: Schema.String }),
})

const EchoToolkit = Toolkit.make(Echo)

const scripted = (turns: ReadonlyArray<ReadonlyArray<Response.StreamPartEncoded>>) =>
  Effect.gen(function* () {
    const index = yield* Ref.make(0)
    return yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () =>
        Stream.unwrap(
          Effect.gen(function* () {
            const i = yield* Ref.getAndUpdate(index, (n) => n + 1)
            return Stream.fromIterable(turns[i] ?? [])
          }),
        ),
    })
  })

const hanging = LanguageModel.make({
  generateText: () => Effect.succeed([]),
  streamText: () =>
    Stream.make({ type: "text-delta" as const, id: "h", delta: "start" }).pipe(
      Stream.concat(Stream.never),
    ),
})

const modelLayer = (model: Effect.Effect<LanguageModel.Service>) =>
  Layer.effect(LanguageModel.LanguageModel, model)

const Main = (model: Effect.Effect<LanguageModel.Service>) =>
  AgentLiveToolkit(EchoToolkit, {
    models: [{ id: "fake", provider: "test", layer: modelLayer(model) }],
  }).pipe(
    Layer.provide(SessionStoreMemory),
    Layer.provide(cryptoWeb),
    Layer.provide(
      EchoToolkit.toLayer({
        echo: ({ note }) => Effect.succeed({ reply: note }),
      }),
    ),
  )

const collect = <A, E = never, R = never>(stream: Stream.Stream<A, E, R>) =>
  Stream.runCollect(stream).pipe(Effect.map((chunk) => [...chunk]))

it.layer(
  Main(
    scripted([
      [{ type: "tool-call" as const, id: "c1", name: "echo", params: { note: "hi" } }],
      [{ type: "text-delta" as const, id: "t1", delta: "done" }],
    ]),
  ),
)("Agent kernel", (it) => {
  it.effect("runs the tool loop and persists history", () =>
    Effect.gen(function* () {
      const agent = yield* Agent
      const events = yield* collect(agent.prompt({ prompt: "say hi", sessionId: "s1" }))

      assert.deepStrictEqual(
        events.map((event: any) => event._tag),
        ["ToolCall", "ToolResult", "TextDelta", "Finish"],
      )
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      const finish = events[3] as any
      assert.strictEqual(finish.reason, "completed")

      const session = yield* agent.history("s1")
      const messages = deriveMessages(session.events)
      assert.deepStrictEqual(
        messages.map((message) => message.role),
        ["user", "assistant", "tool"],
      )
    }),
  )

  it.effect("reports capabilities derived from the toolkit and catalog", () =>
    Effect.gen(function* () {
      const caps = yield* (yield* Agent).capabilities

      assert.deepStrictEqual(
        caps.tools.map((tool) => tool.name),
        ["echo"],
      )
      assert.deepStrictEqual(
        caps.models.map((model) => model.id),
        ["fake"],
      )
      assert.strictEqual(caps.defaultModelId, "fake")
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      const parameters = caps.tools[0]!.parameters as any
      assert.deepStrictEqual(Object.keys(parameters.properties ?? {}), ["note"])
    }),
  )

  it.effect("rejects a missing model id and does not poison the session", () =>
    Effect.gen(function* () {
      const agent = yield* Agent

      const exit = yield* Effect.exit(
        Stream.runDrain(agent.prompt({ prompt: "hi", sessionId: "s2", modelId: "nope" })),
      )
      assert.ok(Exit.isFailure(exit))
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      const failure = Option.getOrThrow(Exit.findErrorOption(exit)) as any
      assert.strictEqual(failure._tag, "ModelNotFound")

      const events = yield* collect(agent.prompt({ prompt: "hi again", sessionId: "s2" }))
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      const finish = events[events.length - 1] as any
      assert.strictEqual(finish.reason, "completed")
    }),
  )
})

const startRun = (agent: Agent["Service"], prompt: string, sessionId: string) =>
  Effect.gen(function* () {
    const queue = yield* Queue.unbounded<any>()
    const fiber = yield* agent.prompt({ prompt, sessionId }).pipe(
      Stream.runForEach((event) => Queue.offer(queue, event)),
      Effect.forkScoped,
    )
    yield* Queue.take(queue)
    return { fiber, queue }
  })

it.layer(Main(hanging))("Agent kernel concurrency", (it) => {
  it.effect("fails with SessionBusy while a run is active", () =>
    Effect.gen(function* () {
      const agent = yield* Agent
      const { fiber } = yield* startRun(agent, "first", "s3")

      const exit = yield* Effect.exit(
        Stream.runDrain(
          agent.prompt({
            prompt: "second",
            sessionId: "s3",
          }),
        ),
      )
      assert.ok(Exit.isFailure(exit))
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      const failure = Option.getOrThrow(Exit.findErrorOption(exit)) as any
      assert.strictEqual(failure._tag, "SessionBusy")

      yield* agent.interrupt("s3")
      yield* Fiber.join(fiber)
    }),
  )

  it.effect("interrupts an active run", () =>
    Effect.gen(function* () {
      const agent = yield* Agent
      const { fiber, queue } = yield* startRun(agent, "work", "s4")

      yield* agent.interrupt("s4")
      yield* Fiber.join(fiber)
      const rest = yield* Queue.takeAll(queue)
      assert.deepStrictEqual(
        rest.map((event: any) => event._tag),
        ["Finish"],
      )
      assert.strictEqual(rest[0].reason, "interrupted")
    }),
  )

  it.effect("persists the user prompt even when interrupted", () =>
    Effect.gen(function* () {
      const agent = yield* Agent
      const { fiber } = yield* startRun(agent, "work", "s5")

      yield* agent.interrupt("s5")
      yield* Fiber.join(fiber)

      const session = yield* agent.history("s5")
      assert.deepStrictEqual(
        deriveMessages(session.events).map((message) => message.role),
        ["user"],
      )
      assert.deepStrictEqual(
        session.events.map((event) => event._tag),
        ["user/message", "turn/start", "step/start", "model/request", "step/end", "turn/end"],
      )
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      const stepEnd = session.events[4] as any
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      const turnEnd = session.events[5] as any
      assert.strictEqual(stepEnd.reason, "interrupted")
      assert.strictEqual(turnEnd.reason, "interrupted")
    }),
  )

  it.effect("errors on unknown session and missing run", () =>
    Effect.gen(function* () {
      const agent = yield* Agent
      const history = yield* Effect.exit(agent.history("nope"))
      assert.ok(Exit.isFailure(history))
      const interrupt = yield* Effect.exit(agent.interrupt("nope"))
      assert.ok(Exit.isFailure(interrupt))
    }),
  )
})

it.layer(
  AgentLiveToolkit(EchoToolkit, {
    models: [{ id: "fake", provider: "test", layer: modelLayer(scripted([[]])) }],
    skills: [{ id: "summarize", description: "summarize text" }],
  }).pipe(
    Layer.provide(SessionStoreMemory),
    Layer.provide(cryptoWeb),
    Layer.provide(
      EchoToolkit.toLayer({
        echo: ({ note }) => Effect.succeed({ reply: note }),
      }),
    ),
  ),
)("capabilities with skills", (it) => {
  it.effect("lists skills when provided", () =>
    Effect.gen(function* () {
      const caps = yield* (yield* Agent).capabilities
      assert.deepStrictEqual(
        caps.skills.map((skill) => skill.id),
        ["summarize"],
      )
    }),
  )
})
const sysPromptDir = await Effect.runPromise(
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.makeTempDirectory({ prefix: "agent-sysprompt-" }),
  ).pipe(Effect.orDie, Effect.provide(NodeFileSystem.layer)),
)

const withSystemPrompt = (systemPrompt: string, prompt: string, sessionId: string) =>
  Effect.gen(function* () {
    const agent = yield* Agent
    yield* Stream.runDrain(agent.prompt({ prompt, sessionId }))
    return yield* agent.history(sessionId)
  }).pipe(
    Effect.provide(
      AgentLiveToolkit(EchoToolkit, {
        systemPrompt,
        models: [
          {
            id: "fake",
            provider: "test",
            layer: modelLayer(
              scripted([[{ type: "text-delta" as const, id: "t1", delta: "done" }]]),
            ),
          },
        ],
      }).pipe(
        Layer.provide(SessionStoreFs(sysPromptDir)),
        Layer.provide(NodeFileSystem.layer),
        Layer.provide(cryptoWeb),
        Layer.provide(
          EchoToolkit.toLayer({
            echo: ({ note }) => Effect.succeed({ reply: note }),
          }),
        ),
      ),
    ),
  )

it.effect("records a new system/message when resuming with a diverging prompt", () =>
  Effect.gen(function* () {
    yield* withSystemPrompt("you are v1", "hello", "sys")
    const session = yield* withSystemPrompt("you are v2", "again", "sys")

    const systemEvents = session.events.filter((event) => event._tag === "system/message")
    assert.deepStrictEqual(
      systemEvents.map((event: any) => event.content),
      ["you are v1", "you are v2"],
    )

    const systems = deriveMessages(session.events).filter((message) => message.role === "system")
    assert.deepStrictEqual(
      systems.map((message: any) => message.content),
      ["you are v1", "you are v2"],
    )
  }),
)

it.effect("does not duplicate the system message when resuming with the same prompt", () =>
  Effect.gen(function* () {
    yield* withSystemPrompt("you are stable", "hello", "stable")
    const session = yield* withSystemPrompt("you are stable", "again", "stable")

    const systemEvents = session.events.filter((event) => event._tag === "system/message")
    assert.deepStrictEqual(
      systemEvents.map((event: any) => event.content),
      ["you are stable"],
    )
  }),
)

const corruptDir = await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectory({ prefix: "agent-corrupt-" })
    yield* fs.writeFileString(`${dir}/corrupt.json`, "{ not json")
    return dir
  }).pipe(Effect.orDie, Effect.provide(NodeFileSystem.layer)),
)
const FsLayer = AgentLiveToolkit(EchoToolkit, {
  models: [
    {
      id: "fake",
      provider: "test",
      layer: modelLayer(scripted([[{ type: "text-delta" as const, id: "t1", delta: "done" }]])),
    },
  ],
}).pipe(
  Layer.provide(SessionStoreFs(corruptDir)),
  Layer.provide(NodeFileSystem.layer),
  Layer.provide(cryptoWeb),
  Layer.provide(
    EchoToolkit.toLayer({
      echo: ({ note }) => Effect.succeed({ reply: note }),
    }),
  ),
)

it.layer(FsLayer)("Agent kernel corrupt session", (it) => {
  it.effect("fails the prompt stream with SessionFormatError on a corrupt log", () =>
    Effect.gen(function* () {
      const agent = yield* Agent

      const exit = yield* Effect.exit(
        Stream.runDrain(agent.prompt({ prompt: "hi", sessionId: "corrupt" })),
      )
      assert.ok(Exit.isFailure(exit))
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      const failure = Option.getOrThrow(Exit.findErrorOption(exit)) as any
      assert.strictEqual(failure._tag, "SessionFormatError")
      assert.strictEqual(failure.sessionId, "corrupt")
    }),
  )
})

it.layer(
  Main(
    scripted([
      [{ type: "tool-call" as const, id: "c1", name: "echo", params: { note: "hi" } }],
      [{ type: "text-delta" as const, id: "t1", delta: "done" }],
    ]),
  ),
)("agent as tool", (it) => {
  it.effect("delegates and returns a summary", () =>
    Effect.gen(function* () {
      const agent = yield* Agent
      const { tool, handler: make } = delegation({
        name: "Delegator",
        description: "delegate work",
      })
      const handler = make(agent)
      assert.strictEqual(tool.name, "Delegator")
      const result = yield* handler({ task: "please echo hi" })
      assert.deepStrictEqual(result, { summary: "done" })
    }),
  )
})

it.layer(
  Main(
    scripted([[{ type: "tool-call" as const, id: "c1", name: "echo", params: { note: "hi" } }]]),
  ),
)("maxTurns", (it) => {
  it.effect("stops the loop at maxTurns", () =>
    Effect.gen(function* () {
      const agent = yield* Agent
      const events = yield* collect(
        agent.prompt({
          prompt: "loop",
          sessionId: "m1",
          maxTurns: 1,
        }),
      )
      assert.deepStrictEqual(
        events.map((event: any) => event._tag),
        ["ToolCall", "ToolResult", "Finish"],
      )
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      const finish = events[2] as any
      assert.strictEqual(finish.reason, "stopped")
    }),
  )
})
