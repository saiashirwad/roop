import { Plugin } from "@roop/agent/Plugin.ts"
import { Effect, Schema, Stream } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import { ChildProcess } from "effect/unstable/process"

import { ExecutionWorld } from "./ExecutionWorld.ts"

export class ToolFailure extends Schema.TaggedErrorClass<ToolFailure>()("ToolFailure", {
  message: Schema.String,
}) {}

export const CodingTools = (_root?: string): Plugin<ExecutionWorld> => {
  const asFailure = <A, E, R = never>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, ToolFailure, R> =>
    effect.pipe(
      Effect.mapError(
        (error: any) => new ToolFailure({ message: error?.message ?? String(error) }),
      ),
    )

  const toolkit = Toolkit.make(
    Tool.make("readFile", {
      description: "Read a UTF-8 text file inside the workspace",
      parameters: Schema.Struct({ path: Schema.String }),
      success: Schema.Struct({ content: Schema.String }),
      failure: ToolFailure,
      failureMode: "return",
      dependencies: [ExecutionWorld],
    }),
    Tool.make("writeFile", {
      description: "Create or overwrite a UTF-8 text file inside the workspace",
      parameters: Schema.Struct({ path: Schema.String, content: Schema.String }),
      success: Schema.Struct({ path: Schema.String }),
      failure: ToolFailure,
      failureMode: "return",
      dependencies: [ExecutionWorld],
    }),
    Tool.make("listFiles", {
      description: "Recursively list file paths under a workspace directory",
      parameters: Schema.Struct({ path: Schema.optionalKey(Schema.String) }),
      success: Schema.Struct({ files: Schema.Array(Schema.String) }),
      failure: ToolFailure,
      failureMode: "return",
      dependencies: [ExecutionWorld],
    }),
    Tool.make("bash", {
      description: "Run a shell command in the workspace and capture stdout, stderr, and exit code",
      parameters: Schema.Struct({ command: Schema.String }),
      success: Schema.Struct({
        exitCode: Schema.Finite,
        stdout: Schema.String,
        stderr: Schema.String,
      }),
      failure: ToolFailure,
      failureMode: "return",
      dependencies: [ExecutionWorld],
    }),
  )

  return Plugin({
    name: "coding-tools",
    toolkit,
    handlers: toolkit.toLayer({
      readFile: ({ path }) =>
        Effect.gen(function* () {
          const world = yield* ExecutionWorld
          const file = yield* asFailure(world.resolvePath(path))
          return yield* asFailure(
            world.filesystem.readFileString(file).pipe(Effect.map((content) => ({ content }))),
          )
        }),
      writeFile: ({ path, content }) =>
        Effect.gen(function* () {
          const world = yield* ExecutionWorld
          const file = yield* asFailure(world.resolvePath(path))
          yield* asFailure(world.filesystem.writeFileString(file, content))
          return { path }
        }),
      listFiles: ({ path }) =>
        Effect.gen(function* () {
          const world = yield* ExecutionWorld
          const dir = yield* asFailure(world.resolvePath(path ?? "."))
          return yield* asFailure(
            world.filesystem
              .readDirectory(dir, { recursive: true })
              .pipe(Effect.map((files) => ({ files }))),
          )
        }),
      bash: ({ command }) =>
        Effect.scoped(
          Effect.gen(function* () {
            const world = yield* ExecutionWorld
            const handle = yield* world.spawner.spawn(
              ChildProcess.make(command, {
                shell: true,
                cwd: world.root,
                env: world.env,
              }),
            )
            const [stdout, stderr, exitCode] = yield* Effect.all(
              [
                Stream.mkString(Stream.decodeText(handle.stdout)),
                Stream.mkString(Stream.decodeText(handle.stderr)),
                handle.exitCode,
              ],
              { concurrency: "unbounded" },
            )
            return { exitCode: Number(exitCode), stdout, stderr }
          }).pipe(Effect.mapError((error: any) => new ToolFailure({ message: error.message }))),
        ),
    }),
  })
}
