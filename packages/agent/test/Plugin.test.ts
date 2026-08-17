import { assert, it } from "@effect/vitest"
import { Effect, Layer, Ref, Schema, Stream } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"

import { Agent } from "../src/Agent.ts"
import { deriveMessages } from "../src/AgentEvents.ts"
import { layerHook } from "../src/AgentHooks.ts"
import { cryptoWeb } from "../src/cryptoWeb.ts"
import { AgentPlugins, Plugin } from "../src/Plugin.ts"
import { SessionJournalMemory } from "../src/SessionJournal.ts"
import { subagent } from "../src/Subagent.ts"
import { scriptedPlugin } from "../src/Testing.ts"

const EchoToolkit = Toolkit.make(
  Tool.make("echo", {
    parameters: Schema.Struct({ note: Schema.String }),
    success: Schema.Struct({ reply: Schema.String }),
  }),
)

const ShoutToolkit = Toolkit.make(
  Tool.make("shout", {
    parameters: Schema.Struct({ note: Schema.String }),
    success: Schema.Struct({ reply: Schema.String }),
  }),
)

const echo = Plugin({
  name: "echo",
  toolkit: EchoToolkit,
  handlers: EchoToolkit.toLayer({ echo: ({ note }) => Effect.succeed({ reply: note }) }),
  systemPrompt: "echo things",
  skills: [{ id: "echoing", description: "repeats notes" }],
})

const shout = Plugin({
  name: "shout",
  toolkit: ShoutToolkit,
  handlers: ShoutToolkit.toLayer({
    shout: ({ note }) => Effect.succeed({ reply: note.toUpperCase() }),
  }),
  systemPrompt: "shout things",
})

const collect = <A, E = never, R = never>(stream: Stream.Stream<A, E, R>) =>
  Stream.runCollect(stream).pipe(Effect.map((chunk) => [...chunk]))

const Composed = AgentPlugins([
  echo,
  shout,
  scriptedPlugin("fake", [
    [
      { type: "tool-call", id: "c1", name: "echo", params: { note: "hi" } },
      { type: "tool-call", id: "c2", name: "shout", params: { note: "hi" } },
    ],
    [{ type: "text-delta", id: "t1", delta: "done" }],
  ]),
]).pipe(Layer.provide(SessionJournalMemory), Layer.provide(cryptoWeb))

const convenience = Plugin.tool({
  name: "convenience",
  parameters: Schema.Struct({ note: Schema.String }),
  success: Schema.Struct({ reply: Schema.String }),
  handler: ({ note }) => Effect.succeed({ reply: note }),
})

const ConvenienceAgent = AgentPlugins([
  convenience,
  scriptedPlugin("convenience-model", [
    [{ type: "tool-call", id: "cc1", name: "convenience", params: { note: "hello" } }],
    [{ type: "text-delta", id: "cc2", delta: "done" }],
  ]),
]).pipe(Layer.provide(SessionJournalMemory), Layer.provide(cryptoWeb))

it.layer(Composed)("AgentPlugins", (it) => {
  it.effect("merges tools, models, skills, and prompts from plugins", () =>
    Effect.gen(function* () {
      const caps = yield* (yield* Agent).capabilities

      assert.deepStrictEqual(
        caps.tools.map((tool) => tool.name),
        ["echo", "shout"],
      )
      assert.deepStrictEqual(
        caps.models.map((entry) => entry.id),
        ["fake"],
      )
      assert.deepStrictEqual(
        caps.skills.map((skill) => skill.id),
        ["echoing"],
      )
    }),
  )

  it.effect("runs tools from different plugins in one turn", () =>
    Effect.gen(function* () {
      const agent = yield* Agent
      const events = yield* collect(agent.prompt({ prompt: "go", sessionId: "p1" }))

      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      const results = events.filter((event) => event._tag === "ToolResult") as Array<any>
      assert.deepStrictEqual(
        results.map((result) => [result.name, result.result.reply]),
        [
          ["echo", "hi"],
          ["shout", "HI"],
        ],
      )

      const session = yield* agent.history("p1")
      const system = deriveMessages(session.events)[0]!
      assert.strictEqual(system.role, "system")
      assert.strictEqual(system.content, "echo things\n\nshout things")
    }),
  )
})

it.layer(ConvenienceAgent)("Plugin.tool", (it) => {
  it.effect("creates and installs a typed tool plugin", () =>
    Effect.gen(function* () {
      const events = yield* collect(
        (yield* Agent).prompt({ prompt: "go", sessionId: "plugin-tool" }),
      )
      const result = events.find((event) => event._tag === "ToolResult")
      assert.ok(result !== undefined && result._tag === "ToolResult")
      if (result?._tag === "ToolResult") assert.deepStrictEqual(result.result, { reply: "hello" })
    }),
  )
})

const worker = subagent({
  name: "worker",
  description: "delegate a task",
  plugins: [
    echo,
    scriptedPlugin("child", [
      [{ type: "tool-call", id: "w1", name: "echo", params: { note: "from child" } }],
      [{ type: "text-delta", id: "w2", delta: "child did the task" }],
    ]),
  ],
})

const hookOrder = Ref.makeUnsafe<Array<string>>([])

const recording = (name: string) =>
  layerHook(name, (downstream) =>
    Effect.succeed({
      ...downstream,
      beforeRequest: (context, request) =>
        Effect.gen(function* () {
          yield* Ref.update(hookOrder, (entries) => [...entries, `${name}:in`])
          const result = yield* downstream.beforeRequest(context, request)
          yield* Ref.update(hookOrder, (entries) => [...entries, `${name}:out`])
          return result
        }),
    }),
  )

const outerHook = Plugin<Record<string, never>, never>({
  name: "outer-hook",
  hooks: recording("outer"),
})
const innerHook = Plugin<Record<string, never>, never>({
  name: "inner-hook",
  hooks: recording("inner"),
})
const Hooked = AgentPlugins([
  outerHook,
  innerHook,
  scriptedPlugin("fake", [[{ type: "text-delta", id: "t1", delta: "done" }]]),
]).pipe(Layer.provide(SessionJournalMemory), Layer.provide(cryptoWeb))

it.layer(Hooked)("plugin hooks", (it) => {
  it.effect("composes plugin hook waterfalls outermost-first", () =>
    Effect.gen(function* () {
      const agent = yield* Agent
      yield* Ref.set(hookOrder, [])
      const events = yield* collect(agent.prompt({ prompt: "go", sessionId: "h1" }))
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      assert.strictEqual((events[events.length - 1] as any).reason, "completed")

      assert.deepStrictEqual(yield* Ref.get(hookOrder), [
        "outer:in",
        "inner:in",
        "inner:out",
        "outer:out",
      ])
    }),
  )
})

const Parent = AgentPlugins([
  worker,
  scriptedPlugin("parent", [
    [{ type: "tool-call", id: "p1", name: "worker", params: { task: "do the thing" } }],
    [{ type: "text-delta", id: "p2", delta: "delegated" }],
  ]),
]).pipe(Layer.provide(SessionJournalMemory), Layer.provide(cryptoWeb))

it.layer(Parent)("subagent", (it) => {
  it.effect("delegates a task to a composed child agent", () =>
    Effect.gen(function* () {
      const agent = yield* Agent

      const caps = yield* agent.capabilities
      assert.deepStrictEqual(
        caps.tools.map((tool) => tool.name),
        ["worker"],
      )

      const events = yield* collect(agent.prompt({ prompt: "delegate", sessionId: "d1" }))
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      const result = events.find((event) => event._tag === "ToolResult") as any
      assert.strictEqual(result.isFailure, false)
      assert.deepStrictEqual(result.result, { summary: "child did the task" })

      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      const nested = events.filter((event) => event._tag === "Subagent") as Array<any>
      assert.deepStrictEqual(
        nested.map((wrapped) => [wrapped.name, wrapped.event._tag]),
        [
          ["worker", "ToolCall"],
          ["worker", "ToolResult"],
          ["worker", "TextDelta"],
          ["worker", "Finish"],
        ],
      )
    }),
  )
})

const concurrentWorker = subagent({
  name: "concurrent-worker",
  description: "delegate an identical task",
  plugins: [
    scriptedPlugin("child-concurrent", [[{ type: "text-delta", id: "cw", delta: "child" }]]),
  ],
})

const ConcurrentParent = AgentPlugins([
  concurrentWorker,
  scriptedPlugin("concurrent-parent", [
    [
      { type: "tool-call", id: "p1", name: "concurrent-worker", params: { task: "same" } },
      { type: "tool-call", id: "p2", name: "concurrent-worker", params: { task: "same" } },
    ],
    [{ type: "text-delta", id: "cp", delta: "done" }],
  ]),
]).pipe(Layer.provide(SessionJournalMemory), Layer.provide(cryptoWeb))

it.layer(ConcurrentParent)("concurrent subagents", (it) => {
  it.effect("correlates identical concurrent calls with their provider ids", () =>
    Effect.gen(function* () {
      const agent = yield* Agent
      const events = yield* collect(
        agent.prompt({ prompt: "delegate twice", sessionId: "concurrent-subagents" }),
      )
      const nested = events.filter(
        (event): event is Extract<(typeof events)[number], { _tag: "Subagent" }> =>
          event._tag === "Subagent",
      )
      assert.strictEqual(nested.length, 4)
      assert.deepStrictEqual(
        nested.map((event) => event.toolCallId),
        [
          "concurrent-subagents:1:1:concurrent-worker:1",
          "concurrent-subagents:1:1:concurrent-worker:1",
          "concurrent-subagents:1:1:concurrent-worker:2",
          "concurrent-subagents:1:1:concurrent-worker:2",
        ],
      )
    }),
  )
})
