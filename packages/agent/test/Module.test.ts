import { assert, it } from "@effect/vitest"
import { Context, Effect, Exit, Option, Schema, Stream } from "effect"
import { Prompt, Tool } from "effect/unstable/ai"

import { Agent } from "../src/Agent.ts"
import type { AgentContext } from "../src/AgentContext.ts"
import { Module } from "../src/Module.ts"
import { ToolConflict } from "../src/ToolRegistry.ts"

const context = (step: number): AgentContext => ({
  sessionId: "session",
  runId: "run",
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

const ordersModule = Module.tool(
  Tool.make("find_order", {
    parameters: Schema.Struct({ id: Schema.String }),
    success: Schema.String,
    dependencies: [Orders],
  }),
  ({ id }) =>
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
