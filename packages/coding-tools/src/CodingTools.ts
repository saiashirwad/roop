import { Plugin } from "@roop/agent/Plugin.ts"
import { Effect, FileSystem, Path, Schema, Stream } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

export class ToolFailure extends Schema.TaggedErrorClass<ToolFailure>()("ToolFailure", {
  message: Schema.String,
}) {}

export const CodingTools = (
  root: string,
): Plugin<FileSystem.FileSystem | ChildProcessSpawner | Path.Path> => {
  const within = (raw: string): Effect.Effect<string, ToolFailure, Path.Path> =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const workspace = path.resolve(root)
      const target = path.isAbsolute(raw) ? raw : path.resolve(workspace, raw)
      const rel = path.relative(workspace, target)
      const escapes = rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)
      if (escapes) {
        return yield* new ToolFailure({ message: `path escapes the workspace: ${raw}` })
      }
      return target
    })

  const asFailure = <A, E extends { readonly message: string }>(
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<A, ToolFailure> =>
    effect.pipe(Effect.mapError((error) => new ToolFailure({ message: error.message })))

  const toolkit = Toolkit.make(
    Tool.make("readFile", {
      description: "Read a UTF-8 text file inside the workspace",
      parameters: Schema.Struct({ path: Schema.String }),
      success: Schema.Struct({ content: Schema.String }),
      failure: ToolFailure,
      failureMode: "return",
      dependencies: [FileSystem.FileSystem, Path.Path],
    }),
    Tool.make("writeFile", {
      description: "Create or overwrite a UTF-8 text file inside the workspace",
      parameters: Schema.Struct({ path: Schema.String, content: Schema.String }),
      success: Schema.Struct({ path: Schema.String }),
      failure: ToolFailure,
      failureMode: "return",
      dependencies: [FileSystem.FileSystem, Path.Path],
    }),
    Tool.make("listFiles", {
      description: "Recursively list file paths under a workspace directory",
      parameters: Schema.Struct({ path: Schema.optionalKey(Schema.String) }),
      success: Schema.Struct({ files: Schema.Array(Schema.String) }),
      failure: ToolFailure,
      failureMode: "return",
      dependencies: [FileSystem.FileSystem, Path.Path],
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
      dependencies: [ChildProcessSpawner, Path.Path],
    }),
  )

  return Plugin({
    name: "coding-tools",
    toolkit,
    handlers: toolkit.toLayer({
      readFile: ({ path }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const file = yield* within(path)
          return yield* asFailure(
            fs.readFileString(file).pipe(Effect.map((content) => ({ content }))),
          )
        }),
      writeFile: ({ path, content }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const file = yield* within(path)
          yield* asFailure(fs.writeFileString(file, content))
          return { path }
        }),
      listFiles: ({ path }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const dir = yield* within(path ?? ".")
          return yield* asFailure(
            fs.readDirectory(dir, { recursive: true }).pipe(Effect.map((files) => ({ files }))),
          )
        }),
      bash: ({ command }) =>
        Effect.scoped(
          Effect.gen(function* () {
            const path = yield* Path.Path
            const spawner = yield* ChildProcessSpawner
            const handle = yield* spawner.spawn(
              ChildProcess.make(command, { shell: true, cwd: path.resolve(root) }),
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
          }).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message }))),
        ),
    }),
  })
}
