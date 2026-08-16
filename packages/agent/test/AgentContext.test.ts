import { assert, it } from "@effect/vitest"
import { Effect, Exit, Option, Schema, Scope } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"

import { AgentContext, AgentContextLive } from "../src/AgentContext.ts"

const Global = Tool.make("echo", {
  description: "global echo",
  parameters: Schema.Struct({ note: Schema.String }),
  success: Schema.Struct({ reply: Schema.String }),
})

const Scoped = Tool.make("echo", {
  description: "scoped echo",
  parameters: Schema.Struct({ note: Schema.String }),
  success: Schema.Struct({ reply: Schema.String }),
})

const Extra = Tool.make("extra", {
  description: "runtime tool",
  parameters: Schema.Struct({}),
  success: Schema.String,
})

const GlobalToolkit = Toolkit.make(Global)
const ScopedToolkit = Toolkit.make(Scoped)
const ExtraToolkit = Toolkit.make(Extra)

const contextLayer = AgentContextLive()

it.layer(contextLayer)("AgentContext", (it) => {
  it.effect("updates the resolved tool view immediately and restores a shadowed tool", () =>
    Effect.gen(function* () {
      const context = yield* AgentContext
      const global = yield* GlobalToolkit.pipe(
        Effect.provide(
          GlobalToolkit.toLayer({ echo: ({ note }) => Effect.succeed({ reply: note }) }),
        ),
      )
      const scoped = yield* ScopedToolkit.pipe(
        Effect.provide(
          ScopedToolkit.toLayer({
            echo: ({ note }) => Effect.succeed({ reply: `scoped:${note}` }),
          }),
        ),
      )

      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      yield* context.registerTool(Global, global as any).pipe(Effect.asVoid)
      assert.strictEqual((yield* context.tools).echo!.description, "global echo")

      const target = yield* Scope.make()
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      yield* Effect.asVoid(context.registerTool(Scoped, scoped as any, { scope: target }))
      assert.strictEqual((yield* context.tools).echo!.description, "scoped echo")

      yield* Scope.close(target, Exit.succeed(undefined))
      assert.strictEqual((yield* context.tools).echo!.description, "global echo")
    }),
  )

  it.effect("removes a registered tool when its owning scope closes", () =>
    Effect.gen(function* () {
      const context = yield* AgentContext
      const extra = yield* ExtraToolkit.pipe(
        Effect.provide(ExtraToolkit.toLayer({ extra: () => Effect.succeed("ok") })),
      )

      const target = yield* Scope.make()
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      yield* Effect.asVoid(context.registerTool(Extra, extra as any, { scope: target }))
      assert.ok("extra" in (yield* context.tools))

      yield* Scope.close(target, Exit.succeed(undefined))
      assert.ok(!("extra" in (yield* context.tools)))
    }),
  )

  it.effect("disposes one duplicate registration without removing its twin", () =>
    Effect.gen(function* () {
      const context = yield* AgentContext
      const beforeTools = Object.keys(yield* context.tools)
      const beforeSections = yield* context.promptSections
      const global = yield* GlobalToolkit.pipe(
        Effect.provide(
          GlobalToolkit.toLayer({ echo: ({ note }) => Effect.succeed({ reply: note }) }),
        ),
      )
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      const first = yield* context.registerTool(Global, global as any)
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      const second = yield* context.registerTool(Global, global as any)
      const promptFirst = yield* context.registerPromptSection("duplicate")
      const promptSecond = yield* context.registerPromptSection("duplicate")

      yield* first
      yield* promptFirst
      assert.strictEqual((yield* context.tools).echo?.name, "echo")
      assert.deepStrictEqual(yield* context.promptSections, ["duplicate"])

      yield* second
      yield* promptSecond
      assert.deepStrictEqual(Object.keys(yield* context.tools), beforeTools)
      assert.deepStrictEqual(yield* context.promptSections, beforeSections)
    }),
  )

  it.effect("reports unknown toolkit calls as typed AiError tool-not-found failures", () =>
    Effect.gen(function* () {
      const context = yield* AgentContext
      /* SAFETY: The empty unknown payload is intentionally sent to an unknown tool. */
      const exit = yield* Effect.exit((yield* context.toolkit).handle("missing", {} as never))
      assert.ok(Exit.isFailure(exit))
      /* SAFETY: Exit.findErrorOption is present after the preceding failure assertion. */
      const error = Option.getOrThrow(Exit.findErrorOption(exit)) as {
        readonly _tag: string
        readonly reason: { readonly _tag: string; readonly toolName: string }
      }
      assert.strictEqual(error._tag, "AiError")
      assert.strictEqual(error.reason._tag, "ToolNotFoundError")
      assert.strictEqual(error.reason.toolName, "missing")
    }),
  )
})
