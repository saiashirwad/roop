import { assert, it } from "@effect/vitest"
import { Effect, Exit, Layer, Option, Schema, Scope } from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai"

import { AgentContext, AgentContextLive, RegistrationConflict } from "../src/AgentContext.ts"
import { scripted } from "../src/Testing.ts"

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

it.layer(AgentContextLive())("AgentContext", (it) => {
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
      yield* Effect.asVoid(context.registerTool(Global, global as any))
      assert.strictEqual((yield* context.tools).echo!.description, "global echo")

      const target = yield* Scope.make()
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      yield* Effect.asVoid(
        context.registerTool(Scoped, scoped as any, { scope: target, conflictPolicy: "replace" }),
      )
      assert.strictEqual((yield* context.tools).echo!.description, "scoped echo")

      yield* Scope.close(target, Exit.succeed(undefined))
      assert.strictEqual((yield* context.tools).echo!.description, "global echo")
    }).pipe(Effect.provide(AgentContextLive())),
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
    }).pipe(Effect.provide(AgentContextLive())),
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
      const second = yield* context.registerTool(Global, global as any, {
        conflictPolicy: "replace",
      })
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
    }).pipe(Effect.provide(AgentContextLive())),
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
    }).pipe(Effect.provide(AgentContextLive())),
  )

  it.effect(
    "fails with RegistrationConflict when duplicate tool is registered under reject policy",
    () =>
      Effect.gen(function* () {
        const context = yield* AgentContext
        const global = yield* GlobalToolkit.pipe(
          Effect.provide(
            GlobalToolkit.toLayer({ echo: ({ note }) => Effect.succeed({ reply: note }) }),
          ),
        )
        /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
        yield* Effect.asVoid(context.registerTool(Global, global as any, { pluginId: "p1" }))

        /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
        const exit = yield* Effect.exit(
          context.registerTool(Global, global as any, {
            pluginId: "p2",
            conflictPolicy: "reject",
          }),
        )
        assert.ok(Exit.isFailure(exit))
        const error = Option.getOrThrow(Exit.findErrorOption(exit))
        assert.ok(Schema.is(RegistrationConflict)(error))
        const conflict = error
        assert.strictEqual(conflict.kind, "tool")
        assert.strictEqual(conflict.name, "echo")
        assert.strictEqual(String(conflict.existingPluginId), "p1")
        assert.strictEqual(String(conflict.newPluginId), "p2")
      }).pipe(Effect.provide(AgentContextLive())),
  )

  it.effect(
    "fails with RegistrationConflict when duplicate model is registered under reject policy",
    () =>
      Effect.gen(function* () {
        const context = yield* AgentContext
        const spec = {
          id: "gpt-4o",
          provider: "test",
          layer: Layer.effect(LanguageModel.LanguageModel, scripted([])),
        }
        yield* Effect.asVoid(context.registerModel(spec, { pluginId: "m1" }))

        const exit = yield* Effect.exit(
          context.registerModel(spec, { pluginId: "m2", conflictPolicy: "reject" }),
        )
        assert.ok(Exit.isFailure(exit))
        const error = Option.getOrThrow(Exit.findErrorOption(exit))
        assert.ok(Schema.is(RegistrationConflict)(error))
        const conflict = error
        assert.strictEqual(conflict.kind, "model")
        assert.strictEqual(conflict.name, "gpt-4o")
        assert.strictEqual(String(conflict.existingPluginId), "m1")
        assert.strictEqual(String(conflict.newPluginId), "m2")
      }).pipe(Effect.provide(AgentContextLive())),
  )

  it.effect(
    "fails with RegistrationConflict when duplicate skill is registered under reject policy",
    () =>
      Effect.gen(function* () {
        const context = yield* AgentContext
        const skill = { id: "code-review", description: "review code" }
        yield* Effect.asVoid(context.registerSkill(skill, { pluginId: "s1" }))

        const exit = yield* Effect.exit(
          context.registerSkill(skill, { pluginId: "s2", conflictPolicy: "reject" }),
        )
        assert.ok(Exit.isFailure(exit))
        const error = Option.getOrThrow(Exit.findErrorOption(exit))
        assert.ok(Schema.is(RegistrationConflict)(error))
        const conflict = error
        assert.strictEqual(conflict.kind, "skill")
        assert.strictEqual(conflict.name, "code-review")
        assert.strictEqual(String(conflict.existingPluginId), "s1")
        assert.strictEqual(String(conflict.newPluginId), "s2")
      }).pipe(Effect.provide(AgentContextLive())),
  )

  it.effect("stacks prompt sections and increases version monotonically", () =>
    Effect.gen(function* () {
      const context = yield* AgentContext
      const v0 = yield* context.version

      yield* Effect.asVoid(context.registerPromptSection("section 1"))
      const v1 = yield* context.version
      assert.ok(v1 > v0)

      const target = yield* Scope.make()
      yield* Effect.asVoid(context.registerPromptSection("section 2", { scope: target }))
      const v2 = yield* context.version
      assert.ok(v2 > v1)

      assert.deepStrictEqual(yield* context.promptSections, ["section 1", "section 2"])

      yield* Scope.close(target, Exit.succeed(undefined))
      const v3 = yield* context.version
      assert.ok(v3 > v2)
      assert.deepStrictEqual(yield* context.promptSections, ["section 1"])
    }).pipe(Effect.provide(AgentContextLive())),
  )
})
