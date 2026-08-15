import { assert, it } from "@effect/vitest"
import { Effect, Exit, Schema, Scope } from "effect"
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
})
