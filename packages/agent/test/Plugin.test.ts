import { assert, it } from "@effect/vitest"
import { Effect, Layer, Ref, Schema, Stream } from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai"

import { Agent } from "../src/Agent.ts"
import { AgentPlugins, Plugin } from "../src/Plugin.ts"
import { SessionStoreMemory } from "../src/SessionStore.ts"
import { subagent } from "../src/subagent.ts"

const scripted = (turns: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>) =>
  Effect.gen(function* () {
    const index = yield* Ref.make(0)
    return yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () =>
        Stream.unwrap(
          Effect.gen(function* () {
            const i = yield* Ref.getAndUpdate(index, (n) => n + 1)
            return Stream.fromIterable((turns[i] ?? []) as never)
          }),
        ),
    })
  })

const model = (id: string, turns: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>): Plugin =>
  Plugin({
    name: `model-${id}`,
    models: [
      { id, provider: "test", layer: Layer.effect(LanguageModel.LanguageModel, scripted(turns)) },
    ],
  })

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

const collect = (stream: Stream.Stream<unknown, unknown>) =>
  Stream.runCollect(stream).pipe(Effect.map((chunk) => [...chunk]))

const Composed = AgentPlugins([
  echo,
  shout,
  model("fake", [
    [
      { type: "tool-call", id: "c1", name: "echo", params: { note: "hi" } },
      { type: "tool-call", id: "c2", name: "shout", params: { note: "hi" } },
    ],
    [{ type: "text-delta", id: "t1", delta: "done" }],
  ]),
]).pipe(Layer.provide(SessionStoreMemory))

it.layer(Composed)("AgentPlugins", (it) => {
  it.effect("merges tools, models, skills, and prompts from plugins", () =>
    Effect.gen(function* () {
      const caps = yield* (yield* Agent).capabilities()

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

      const results = events.filter((event: any) => event._tag === "ToolResult") as Array<any>
      assert.deepStrictEqual(
        results.map((result) => [result.name, result.result.reply]),
        [
          ["echo", "hi"],
          ["shout", "HI"],
        ],
      )

      const session = yield* agent.history("p1")
      const system = session.messages[0]!
      assert.strictEqual(system.role, "system")
      assert.strictEqual(system.content, "echo things\n\nshout things")
    }),
  )
})

const worker = subagent({
  name: "worker",
  description: "delegate a task",
  plugins: [
    echo,
    model("child", [
      [{ type: "tool-call", id: "w1", name: "echo", params: { note: "from child" } }],
      [{ type: "text-delta", id: "w2", delta: "child did the task" }],
    ]),
  ],
})

const Parent = AgentPlugins([
  worker,
  model("parent", [
    [{ type: "tool-call", id: "p1", name: "worker", params: { task: "do the thing" } }],
    [{ type: "text-delta", id: "p2", delta: "delegated" }],
  ]),
]).pipe(Layer.provide(SessionStoreMemory))

it.layer(Parent)("subagent", (it) => {
  it.effect("delegates a task to a composed child agent", () =>
    Effect.gen(function* () {
      const agent = yield* Agent

      const caps = yield* agent.capabilities()
      assert.deepStrictEqual(
        caps.tools.map((tool) => tool.name),
        ["worker"],
      )

      const events = yield* collect(agent.prompt({ prompt: "delegate", sessionId: "d1" }))
      const result = events.find((event: any) => event._tag === "ToolResult") as any
      assert.strictEqual(result.isFailure, false)
      assert.deepStrictEqual(result.result, { summary: "child did the task" })
    }),
  )
})
