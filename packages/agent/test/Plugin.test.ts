import { assert, it } from "@effect/vitest"
import { Effect, Exit, Layer, Ref, Schema, Scope, Stream } from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai"

import { Agent } from "../src/Agent.ts"
import { AgentContext } from "../src/AgentContext.ts"
import { deriveMessages } from "../src/AgentEvents.ts"
import { layerHook } from "../src/AgentHooks.ts"
import { cryptoWeb } from "../src/cryptoWeb.ts"
import { AgentPlugins, Plugin } from "../src/Plugin.ts"
import { SessionJournalMemory } from "../src/SessionJournal.ts"
import { subagent } from "../src/Subagent.ts"
import { scripted, scriptedPlugin } from "../src/Testing.ts"

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

// --- issue C: scope-bound runtime registration ---

const LaterTool = Tool.make("later", {
  description: "registered at runtime",
  parameters: Schema.Struct({}),
  success: Schema.String,
})
const LaterToolkit = Toolkit.make(LaterTool)

const ShadowTool = Tool.make("echo", {
  description: "scoped shadow of the static echo",
  parameters: Schema.Struct({ note: Schema.String }),
  success: Schema.Struct({ reply: Schema.String }),
})
const ShadowToolkit = Toolkit.make(ShadowTool)

const EphemeralTool = Tool.make("ephemeral", {
  description: "removed by its disposer",
  parameters: Schema.Struct({}),
  success: Schema.String,
})
const EphemeralToolkit = Toolkit.make(EphemeralTool)

const ProbeTool = Tool.make("probe", {
  description: "registers the later tool mid-run",
  parameters: Schema.Struct({}),
  success: Schema.Struct({ ok: Schema.Boolean }),
})
const ProbeToolkit = Toolkit.make(ProbeTool)

const laterHandle = LaterToolkit.pipe(
  Effect.provide(LaterToolkit.toLayer({ later: () => Effect.succeed("late") })),
)

/** Stashes the live registry so tests can act on the agent's own AgentContext. */
const registries = Ref.makeUnsafe<ReadonlyArray<AgentContext["Service"]>>([])

const registryOf = Effect.map(Ref.get(registries), (all) => {
  const context = all.at(-1)
  if (context === undefined) throw new Error("no registry stashed")
  return context
})

/** A plugin whose handler layer registers every kind of capability at build. */
const registrar = Plugin({
  name: "registrar",
  install: Layer.effectDiscard(
    Effect.gen(function* () {
      const context = yield* AgentContext
      yield* Ref.update(registries, (all) => [...all, context])
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      yield* Effect.asVoid(
        Effect.orDie(context.registerTool(LaterTool, (yield* laterHandle) as any)),
      )
      yield* Effect.asVoid(
        Effect.orDie(
          context.registerModel({
            id: "late-model",
            provider: "test",
            layer: Layer.effect(LanguageModel.LanguageModel, scripted([[]])),
          }),
        ),
      )
      yield* Effect.asVoid(
        Effect.orDie(
          context.registerSkill({ id: "late-skill", description: "registered at runtime" }),
        ),
      )
      yield* Effect.asVoid(Effect.orDie(context.registerPromptSection("late section")))
    }),
  ),
})

/** A plugin whose tool handler registers mid-run, with no ambient scope. */
const prober = Plugin({
  name: "prober",
  toolkit: ProbeToolkit,
  handlers: ProbeToolkit.toLayer(
    Effect.gen(function* () {
      const context = yield* AgentContext
      return {
        probe: () =>
          Effect.gen(function* () {
            /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
            yield* Effect.asVoid(
              Effect.orDie(context.registerTool(LaterTool, (yield* laterHandle) as any)),
            )
            yield* Effect.asVoid(Effect.orDie(context.registerPromptSection("mid-run section")))
            return { ok: true }
          }),
      }
    }),
  ),
})

const Registered = AgentPlugins([
  echo,
  registrar,
  scriptedPlugin("fake", [[{ type: "text-delta", id: "t1", delta: "done" }]]),
]).pipe(Layer.provide(SessionJournalMemory), Layer.provide(cryptoWeb))

it.layer(Registered)("runtime registration", (it) => {
  it.effect("reflects handler-registered tools, models, skills, and sections in capabilities", () =>
    Effect.gen(function* () {
      const caps = yield* (yield* Agent).capabilities
      assert.deepStrictEqual(
        caps.tools.map((tool) => tool.name),
        ["echo", "later"],
      )
      assert.deepStrictEqual(
        caps.models.map((entry) => entry.id),
        ["late-model", "fake"],
      )
      assert.deepStrictEqual(
        caps.skills.map((skill) => skill.id),
        ["echoing", "late-skill"],
      )
      const context = yield* registryOf
      assert.deepStrictEqual(yield* context.promptSections, ["echo things", "late section"])
      assert.strictEqual(yield* context.systemPrompt, "echo things\n\nlate section")
    }),
  )

  it.effect("a scoped registration shadows the static twin until its scope closes", () =>
    Effect.gen(function* () {
      const context = yield* registryOf
      const shadow = yield* ShadowToolkit.pipe(
        Effect.provide(
          ShadowToolkit.toLayer({
            echo: ({ note }) => Effect.succeed({ reply: `shadow:${note}` }),
          }),
        ),
      )

      const agent = yield* Agent
      const before = yield* agent.capabilities
      assert.strictEqual(before.tools.find((tool) => tool.name === "echo")?.description, "")

      const target = yield* Scope.make()
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      yield* Effect.asVoid(
        Effect.orDie(
          context.registerTool(ShadowTool, shadow as any, {
            scope: target,
            conflictPolicy: "replace",
          }),
        ),
      )
      const during = yield* agent.capabilities
      assert.strictEqual(
        during.tools.find((tool) => tool.name === "echo")?.description,
        "scoped shadow of the static echo",
      )
      yield* Scope.close(target, Exit.succeed(undefined))

      const after = yield* agent.capabilities
      assert.strictEqual(after.tools.find((tool) => tool.name === "echo")?.description, "")
    }),
  )

  it.effect("the explicit disposer removes a registration without closing the agent", () =>
    Effect.gen(function* () {
      const context = yield* registryOf
      const ephemeral = yield* EphemeralToolkit.pipe(
        Effect.provide(EphemeralToolkit.toLayer({ ephemeral: () => Effect.succeed("gone") })),
      )
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      const dispose = yield* Effect.orDie(context.registerTool(EphemeralTool, ephemeral as any))
      assert.ok((yield* context.tools).ephemeral !== undefined)

      yield* dispose
      const caps = yield* (yield* Agent).capabilities
      assert.ok(caps.tools.every((tool) => tool.name !== "ephemeral"))
    }),
  )
})

it.effect("unwinds every registration when the agent layer's scope closes", () =>
  Effect.gen(function* () {
    yield* Ref.set(registries, [])
    const scope = yield* Scope.make()
    yield* Layer.buildWithScope(
      AgentPlugins([
        echo,
        registrar,
        scriptedPlugin("fake", [[{ type: "text-delta", id: "t1", delta: "done" }]]),
      ]),
      scope,
    ).pipe(Effect.provide([SessionJournalMemory, cryptoWeb]))
    const context = yield* registryOf
    assert.deepStrictEqual(Object.keys(yield* context.tools), ["echo", "later"])

    yield* Scope.close(scope, Exit.succeed(undefined))
    assert.deepStrictEqual(Object.keys(yield* context.tools), [])
    assert.deepStrictEqual(yield* context.models, [])
    assert.deepStrictEqual(yield* context.skills, [])
    assert.deepStrictEqual(yield* context.promptSections, [])
  }),
)

const MidRun = AgentPlugins([
  prober,
  scriptedPlugin("fake", [
    [{ type: "tool-call", id: "c1", name: "probe", params: {} }],
    [{ type: "tool-call", id: "c2", name: "later", params: {} }],
    [{ type: "text-delta", id: "t1", delta: "done" }],
  ]),
]).pipe(Layer.provide(SessionJournalMemory), Layer.provide(cryptoWeb))

it.layer(MidRun)("mid-run registration", (it) => {
  it.effect("a tool handler can register a tool that the next step executes", () =>
    Effect.gen(function* () {
      const agent = yield* Agent
      const events = yield* collect(agent.prompt({ prompt: "go", sessionId: "r1" }))
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      const results = events.filter((event) => event._tag === "ToolResult") as Array<any>
      assert.deepStrictEqual(
        results.map((result) => [result.name, result.result]),
        [
          ["probe", { ok: true }],
          ["later", "late"],
        ],
      )

      // The mid-run prompt section is journaled before the next request.
      const session = yield* agent.history("r1")
      assert.deepStrictEqual(
        session.events
          .filter((event) => event._tag === "system/message")
          .map(
            /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
            (event) => event.content,
          ),
        ["mid-run section"],
      )
      const systems = deriveMessages(session.events).filter((message) => message.role === "system")
      assert.strictEqual(systems.length, 1)
    }),
  )

  it.effect("mid-run registrations bind to the agent scope and survive the tool call", () =>
    Effect.gen(function* () {
      const agent = yield* Agent
      yield* collect(agent.prompt({ prompt: "go", sessionId: "r2" }))
      const caps = yield* agent.capabilities
      assert.ok(caps.tools.some((tool) => tool.name === "later"))
    }),
  )
})
