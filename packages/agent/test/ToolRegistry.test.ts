import { assert, it } from "@effect/vitest"
import { Effect, Exit, Option, Schema } from "effect"
import { Prompt, Tool } from "effect/unstable/ai"

import { Module } from "../src/Module.ts"
import { InvalidToolName, ToolConflict } from "../src/ToolRegistry.ts"

const context = {
  sessionId: "session",
  runId: "run",
  turn: 1,
  step: 1,
  history: Prompt.empty,
} as const

it.effect("rejects an empty tool name before compiling the toolkit", () =>
  Effect.gen(function* () {
    const empty = Tool.make("", {
      parameters: Schema.Struct({}),
      success: Schema.String,
    })
    const built = yield* Module.tool(empty, () => Effect.succeed("ok")).build(context)
    const exit = yield* Effect.exit(built.tools.finalize)
    assert.ok(Exit.isFailure(exit))
    if (Exit.isFailure(exit)) {
      assert.ok(Option.getOrThrow(Exit.findErrorOption(exit)) instanceof InvalidToolName)
    }
  }),
)

it.effect("keeps duplicate conflict results stable under regrouping", () =>
  Effect.gen(function* () {
    const tool = Tool.make("same", { success: Schema.String })
    const left = Module.all(
      Module.tool(tool, () => Effect.succeed("a"), "a"),
      Module.tool(tool, () => Effect.succeed("b"), "b"),
    )
    const right = Module.all(
      Module.tool(tool, () => Effect.succeed("a"), "a"),
      Module.all(Module.tool(tool, () => Effect.succeed("b"), "b")),
    )

    const leftExit = yield* Effect.exit(
      Module.all(left)
        .build(context)
        .pipe(Effect.flatMap((part) => part.tools.finalize)),
    )
    const rightExit = yield* Effect.exit(
      right.build(context).pipe(Effect.flatMap((part) => part.tools.finalize)),
    )

    const conflict = (exit: typeof leftExit): ReadonlyArray<string> => {
      if (!Exit.isFailure(exit)) return []
      const error = Option.getOrThrow(Exit.findErrorOption(exit))
      return error instanceof ToolConflict ? error.contributors : []
    }
    assert.deepStrictEqual(conflict(leftExit), ["a", "b"])
    assert.deepStrictEqual(conflict(rightExit), ["a", "b"])
  }),
)
