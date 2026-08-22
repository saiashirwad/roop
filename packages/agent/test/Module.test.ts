import { assert, it } from "@effect/vitest"
import { Context, Effect, Exit, Layer, Option, Ref, Schema, Stream } from "effect"
import { LanguageModel, Prompt, Tool } from "effect/unstable/ai"

import { Agent } from "../src/Agent.ts"
import type { AgentContext } from "../src/AgentContext.ts"
import { RunId, SessionId } from "../src/DomainIds.ts"
import { JournalMemory } from "../src/JournalMemory.ts"
import { Module } from "../src/Module.ts"
import { runAgent } from "../src/Runtime.ts"
import { ToolConflict } from "../src/ToolRegistry.ts"

const context = (step: number): AgentContext => ({
  sessionId: SessionId.make("session"),
  runId: RunId.make("run"),
  turn: 1,
  step,
  history: Prompt.empty,
})

const inspect = Tool.make("inspect", {
  parameters: Schema.Struct({ id: Schema.String }),
  success: Schema.String,
})

const commit = Tool.make("commit", {
  parameters: Schema.Struct({ id: Schema.String }),
  success: Schema.String,
})

const inspectModule = Module.tool(inspect, ({ id }) => Effect.succeed(`inspected ${id}`), "inspect")
const commitModule = Module.tool(commit, ({ id }) => Effect.succeed(`committed ${id}`), "commit")

it.effect("composes empty modules and preserves instruction order", () =>
  Effect.gen(function* () {
    const module = Module.all(
      Module.empty,
      Module.instructions("first", "first"),
      Module.all(Module.instructions("second", "second"), Module.empty),
    )
    const built = yield* module.build(context(1))
    assert.deepStrictEqual(built.instructions, [
      { text: "first", contributor: "first" },
      { text: "second", contributor: "second" },
    ])
    assert.deepStrictEqual((yield* built.tools.finalize).tools, [])
  }),
)

it.effect("renders the same conditional module against explicit contexts", () =>
  Effect.gen(function* () {
    const conditional = Module.all(
      Module.when((current) => current.step === 1, inspectModule),
      Module.when((current) => current.step === 2, commitModule),
    )
    const first = yield* conditional.build(context(1))
    const second = yield* conditional.build(context(2))

    assert.deepStrictEqual(
      (yield* first.tools.finalize).tools.map((tool) => tool.name),
      ["inspect"],
    )
    assert.deepStrictEqual(
      (yield* second.tools.finalize).tools.map((tool) => tool.name),
      ["commit"],
    )

    const agent = Agent.make("support", conditional)
    const plan = yield* agent.render(context(2))
    assert.deepStrictEqual(
      plan.tools.contributions.map((item) => item.tool.name),
      ["commit"],
    )
  }),
)

it.effect("reports all duplicate contributors in declaration order", () =>
  Effect.gen(function* () {
    const duplicate = Tool.make("lookup", {
      parameters: Schema.Struct({ id: Schema.String }),
      success: Schema.String,
    })
    const module = Module.all(
      Module.tool(duplicate, ({ id }) => Effect.succeed(id), "orders"),
      Module.all(
        Module.tool(duplicate, ({ id }) => Effect.succeed(id), "support"),
        Module.tool(duplicate, ({ id }) => Effect.succeed(id), "billing"),
      ),
    )
    const built = yield* module.build(context(1))
    const exit = yield* Effect.exit(built.tools.finalize)
    assert.ok(Exit.isFailure(exit))
    if (Exit.isFailure(exit)) {
      const error = Option.getOrThrow(Exit.findErrorOption(exit))
      assert.ok(Schema.is(ToolConflict)(error))
      if (Schema.is(ToolConflict)(error)) {
        assert.strictEqual(error.name, "lookup")
        assert.deepStrictEqual(error.contributors, ["orders", "support", "billing"])
      }
    }
  }),
)

class Orders extends Context.Service<Orders, { readonly find: (id: string) => string }>()(
  "test/Orders",
) {}

const ordersTool = Tool.make("find_order", {
  parameters: Schema.Struct({ id: Schema.String }),
  success: Schema.String,
  dependencies: [Orders],
})

const ordersModule = Module.tool(ordersTool, ({ id }) =>
  Effect.gen(function* () {
    const orders = yield* Orders
    return orders.find(id)
  }),
)

it.effect("provides handler services through the module boundary", () =>
  Effect.gen(function* () {
    const built = yield* ordersModule.build(context(1))
    const finalized = yield* built.tools.finalize
    const result = yield* finalized.toolkit.handle("find_order", { id: "42" })
    const chunks = yield* result.pipe(Stream.runCollect)
    assert.strictEqual(chunks[0]?.result, "order:42")
  }).pipe(Effect.provideService(Orders, { find: (id) => `order:${id}` })),
)

it.effect("Module.provide closes tool requirements through runAgent with no ambient service", () =>
  Effect.gen(function* () {
    const closed = Module.provide(ordersModule, Orders, Orders.of({ find: (id) => `order:${id}` }))
    const agent = Agent.make("orders-agent", closed)

    const model = yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () =>
        Stream.fromIterable([
          {
            type: "tool-call" as const,
            id: "call-1",
            name: "find_order",
            params: { id: "101" },
          },
          { type: "text-delta" as const, id: "done", delta: "finished" },
        ]),
    })

    const events = yield* runAgent(agent, {
      sessionId: "closed-orders-session",
      prompt: "find order 101",
    }).pipe(
      Stream.runCollect,
      Effect.provide(JournalMemory),
      Effect.provideService(LanguageModel.LanguageModel, model),
    )

    const resultEvent = events.find((e) => e._tag === "ToolResult")
    assert.ok(resultEvent?._tag === "ToolResult")
    if (resultEvent?._tag === "ToolResult") {
      assert.strictEqual(resultEvent.result, "order:101")
      assert.strictEqual(resultEvent.isFailure, false)
    }
  }),
)

it.effect("Module.provideLayer keeps scoped resources alive until tool execution finishes", () =>
  Effect.gen(function* () {
    const acquireCount = yield* Ref.make(0)
    const releaseCount = yield* Ref.make(0)

    class Resource extends Context.Service<Resource, { readonly get: () => string }>()(
      "test/Resource",
    ) {}

    const resourceLayer = Layer.effect(
      Resource,
      Effect.acquireRelease(
        Ref.update(acquireCount, (n) => n + 1).pipe(
          Effect.as(Resource.of({ get: () => "resource-active" })),
        ),
        () => Ref.update(releaseCount, (n) => n + 1),
      ),
    )

    const resourceTool = Tool.make("get_resource", {
      parameters: Schema.Struct({}),
      success: Schema.String,
      dependencies: [Resource],
    })

    const resourceModule = Module.tool(resourceTool, () =>
      Effect.gen(function* () {
        const res = yield* Resource
        return res.get()
      }),
    )

    const closedModule = Module.provideLayer(resourceModule, resourceLayer)
    const built = yield* closedModule.build(context(1))
    assert.strictEqual(yield* Ref.get(acquireCount), 1)
    assert.strictEqual(yield* Ref.get(releaseCount), 1)

    const finalized = yield* Effect.scoped(
      Effect.gen(function* () {
        const fin = yield* built.tools.finalize
        assert.strictEqual(yield* Ref.get(acquireCount), 2)
        assert.strictEqual(yield* Ref.get(releaseCount), 1)
        const result = yield* fin.toolkit.handle("get_resource", {})
        const chunks = yield* result.pipe(Stream.runCollect)
        assert.strictEqual(chunks[0]?.result, "resource-active")
        return fin
      }),
    )
    assert.ok(finalized !== undefined)
    assert.strictEqual(yield* Ref.get(releaseCount), 2)
  }),
)
