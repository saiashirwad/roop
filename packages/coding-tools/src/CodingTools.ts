import { Plugin } from "@roop/agent/Plugin.ts"
import { Effect, Schema, Stream } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import { ChildProcess } from "effect/unstable/process"

import { applyPatchTransaction } from "./ApplyPatch.ts"
import {
  ExecutionWorld,
  type ExecutionWorldService,
  normalizeWorkspacePath,
} from "./ExecutionWorld.ts"
import { ToolFailure } from "./ToolFailure.ts"

export { ToolFailure } from "./ToolFailure.ts"

const makeGrepRegex = (pattern: string, caseSensitive?: boolean): RegExp => {
  try {
    return new RegExp(pattern, caseSensitive ? "" : "i")
  } catch {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    return new RegExp(escaped, caseSensitive ? "" : "i")
  }
}

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const isIgnoredWorkspacePath = (file: string): boolean =>
  file
    .replaceAll("\\", "/")
    .split("/")
    .some((segment) => segment === ".git" || segment === "node_modules" || segment === ".roop")

/** Resolve an entry returned by readDirectory, which is relative to targetDir. */
const resolveDirectoryEntry = (world: ExecutionWorldService, targetDir: string, entry: string) =>
  world.resolvePath(`${targetDir.replace(/[\\/]$/, "")}/${entry}`)

export const CodingTools = (): Plugin<ExecutionWorld> => {
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
    Tool.make("edit", {
      description:
        "Apply one or more targeted string replacements to a file inside the workspace. Each oldText must match uniquely in the file.",
      parameters: Schema.Struct({
        path: Schema.String,
        edits: Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              oldText: Schema.String,
              newText: Schema.String,
            }),
          ),
        ),
        oldText: Schema.optionalKey(Schema.String),
        newText: Schema.optionalKey(Schema.String),
      }),
      success: Schema.Struct({
        path: Schema.String,
        appliedEdits: Schema.Finite,
      }),
      failure: ToolFailure,
      failureMode: "return",
      dependencies: [ExecutionWorld],
    }),
    Tool.make("applyPatch", {
      description:
        "Apply a multi-file diff, unified diff, or OpenAI patch block (*** Begin Patch) to create, update, move, or delete files atomically.",
      parameters: Schema.Struct({
        patch: Schema.optionalKey(Schema.String),
        patchText: Schema.optionalKey(Schema.String),
        diff: Schema.optionalKey(Schema.String),
      }),
      success: Schema.Struct({
        summary: Schema.String,
        files: Schema.Array(Schema.String),
      }),
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
    Tool.make("find", {
      description:
        "Find file paths in the workspace matching an optional substring or glob wildcard pattern (e.g. *.ts)",
      parameters: Schema.Struct({
        pattern: Schema.optionalKey(Schema.String),
        path: Schema.optionalKey(Schema.String),
        limit: Schema.optionalKey(NonNegativeInt),
      }),
      success: Schema.Struct({
        files: Schema.Array(Schema.String),
        totalFiles: Schema.Finite,
        truncated: Schema.Boolean,
      }),
      failure: ToolFailure,
      failureMode: "return",
      dependencies: [ExecutionWorld],
    }),
    Tool.make("grep", {
      description:
        "Search file contents in the workspace for lines matching a regex pattern or literal text",
      parameters: Schema.Struct({
        pattern: Schema.String,
        path: Schema.optionalKey(Schema.String),
        caseSensitive: Schema.optionalKey(Schema.Boolean),
        limit: Schema.optionalKey(NonNegativeInt),
      }),
      success: Schema.Struct({
        matches: Schema.Array(
          Schema.Struct({
            file: Schema.String,
            line: Schema.Finite,
            content: Schema.String,
          }),
        ),
        totalMatches: Schema.Finite,
        truncated: Schema.Boolean,
      }),
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
      edit: ({ path, edits, oldText, newText }) =>
        Effect.gen(function* () {
          const world = yield* ExecutionWorld
          const file = yield* asFailure(world.resolvePath(path))
          const rawEdits =
            edits ?? (oldText !== undefined && newText !== undefined ? [{ oldText, newText }] : [])
          if (rawEdits.length === 0) {
            return yield* new ToolFailure({
              message:
                "No edits specified: provide either an 'edits' array or 'oldText' and 'newText'",
            })
          }
          let content = yield* asFailure(world.filesystem.readFileString(file))
          let appliedEdits = 0
          for (const editItem of rawEdits) {
            if (editItem.oldText === "") {
              return yield* new ToolFailure({ message: "oldText cannot be empty" })
            }
            let count = 0
            for (let offset = 0; ;) {
              const index = content.indexOf(editItem.oldText, offset)
              if (index === -1) break
              count += 1
              // Advance one character so overlapping occurrences are counted too.
              offset = index + 1
            }
            if (count === 0) {
              const preview =
                editItem.oldText.length > 60
                  ? `${editItem.oldText.slice(0, 60)}…`
                  : editItem.oldText
              return yield* new ToolFailure({
                message: `oldText not found in ${path}: "${preview}"`,
              })
            }
            if (count > 1) {
              const preview =
                editItem.oldText.length > 60
                  ? `${editItem.oldText.slice(0, 60)}…`
                  : editItem.oldText
              return yield* new ToolFailure({
                message: `oldText matches ${count} times in ${path}; provide more surrounding context to disambiguate: "${preview}"`,
              })
            }
            content = content.replace(editItem.oldText, () => editItem.newText)
            appliedEdits += 1
          }
          yield* asFailure(world.filesystem.writeFileString(file, content))
          return { path, appliedEdits }
        }),
      applyPatch: ({ patch, patchText, diff }) =>
        Effect.gen(function* () {
          const world = yield* ExecutionWorld
          const rawPatch = patch ?? patchText ?? diff
          if (rawPatch === undefined || rawPatch.trim() === "") {
            return yield* new ToolFailure({
              message: "No patch content provided: 'patch' parameter is required",
            })
          }
          return yield* applyPatchTransaction(world, rawPatch)
        }),
      listFiles: ({ path }) =>
        Effect.gen(function* () {
          const world = yield* ExecutionWorld
          const dir = yield* asFailure(world.resolvePath(path ?? "."))
          const entries: ReadonlyArray<string> = yield* asFailure(
            world.filesystem.readDirectory(dir, { recursive: true }),
          )
          const files = yield* Effect.forEach(entries, (entry) =>
            asFailure(resolveDirectoryEntry(world, dir, entry)).pipe(
              Effect.map((resolved) => normalizeWorkspacePath(world, resolved)),
            ),
          )
          return { files: files.filter((file) => !isIgnoredWorkspacePath(file)) }
        }),
      find: ({ pattern, path: searchPath, limit }) =>
        Effect.gen(function* () {
          const maxLimit = limit ?? 100
          const world = yield* ExecutionWorld
          const targetDir = yield* asFailure(world.resolvePath(searchPath ?? "."))
          const rawFiles: ReadonlyArray<string> = yield* asFailure(
            world.filesystem.readDirectory(targetDir, { recursive: true }),
          )
          const entries = yield* Effect.forEach(rawFiles, (entry) =>
            asFailure(resolveDirectoryEntry(world, targetDir, entry)).pipe(
              Effect.map((resolved) => ({ file: normalizeWorkspacePath(world, resolved) })),
            ),
          )

          const filtered = entries.filter(({ file }) => !isIgnoredWorkspacePath(file))

          let matched = filtered
          if (pattern && pattern.trim() !== "") {
            const p = pattern.trim()
            if (p.includes("*")) {
              const regex = new RegExp(
                "^" +
                  p
                    .split("*")
                    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
                    .join(".*") +
                  "$",
                "i",
              )
              matched = filtered.filter(
                ({ file }) => regex.test(file) || regex.test(file.split("/").pop() ?? ""),
              )
            } else {
              matched = filtered.filter(({ file }) => file.toLowerCase().includes(p.toLowerCase()))
            }
          }

          const totalFiles = matched.length
          const files = matched.slice(0, maxLimit).map(({ file }) => file)
          return {
            files,
            totalFiles,
            truncated: totalFiles > files.length,
          }
        }),
      grep: ({ pattern, path: searchPath, caseSensitive, limit }) =>
        Effect.gen(function* () {
          const maxLimit = limit ?? 100
          const world = yield* ExecutionWorld
          const targetDir = yield* asFailure(world.resolvePath(searchPath ?? "."))
          const allFiles: ReadonlyArray<string> = yield* asFailure(
            world.filesystem.readDirectory(targetDir, { recursive: true }),
          )

          const regex = makeGrepRegex(pattern, caseSensitive)
          const matches: Array<{ file: string; line: number; content: string }> = []
          let totalMatches = 0
          for (const entry of allFiles) {
            const fullPath = yield* asFailure(resolveDirectoryEntry(world, targetDir, entry))
            const relFile = normalizeWorkspacePath(world, fullPath)
            if (isIgnoredWorkspacePath(relFile)) {
              continue
            }
            const contentOption = yield* world.filesystem
              .readFileString(fullPath)
              .pipe(Effect.option)
            if (contentOption._tag === "None") continue

            const lines = contentOption.value.split(/\r?\n/)
            for (let i = 0; i < lines.length; i++) {
              const lineText = lines[i]!
              regex.lastIndex = 0
              if (regex.test(lineText)) {
                totalMatches += 1
                if (matches.length < maxLimit) {
                  matches.push({
                    file: relFile,
                    line: i + 1,
                    content: lineText.length > 200 ? `${lineText.slice(0, 200)}…` : lineText,
                  })
                }
              }
            }
          }

          return {
            matches,
            totalMatches,
            truncated: totalMatches > matches.length,
          }
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
