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
import { Truncate } from "./Truncate.ts"

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

interface ReadFileResult {
  content: string
  truncated?: boolean | undefined
  spillPath?: string | undefined
  hint?: string | undefined
  lineOffset?: number | undefined
  totalLines?: number | undefined
  nextOffset?: number | undefined
}

interface GrepMatch {
  file: string
  line: number
  content: string
}

interface GrepResult {
  matches: Array<GrepMatch>
  totalMatches: number
  truncated: boolean
  output?: string | undefined
  spillPath?: string | undefined
  hint?: string | undefined
}

interface BashResult {
  exitCode: number
  stdout: string
  stderr: string
  stdoutTruncated?: boolean | undefined
  stderrTruncated?: boolean | undefined
  spillPath?: string | undefined
  stdoutSpillPath?: string | undefined
  stderrSpillPath?: string | undefined
  stdoutHint?: string | undefined
  stderrHint?: string | undefined
}

const isIgnoredWorkspacePath = (file: string): boolean =>
  file
    .replaceAll("\\", "/")
    .split("/")
    .some((segment) => segment === ".git" || segment === "node_modules" || segment === ".roop")

interface LineWindow {
  readonly content: string
  readonly totalLines: number
  readonly nextOffset?: number | undefined
}

const splitLines = (text: string): Array<string> => text.split(/\r?\n/)

const windowFromText = (raw: string, offset: number, limit: number | undefined): LineWindow => {
  const lines = splitLines(raw)
  const selected = lines.slice(offset, limit === undefined ? undefined : offset + limit)
  const nextOffset = offset + (limit ?? lines.length)
  return {
    content: selected.join("\n"),
    totalLines: lines.length,
    nextOffset: nextOffset < lines.length ? nextOffset : undefined,
  }
}

/** Scan a byte stream for a line window without holding the rest of the file. */
const windowFromStream = <E, R>(
  bytes: Stream.Stream<Uint8Array, E, R>,
  offset: number,
  limit: number | undefined,
) =>
  Effect.gen(function* () {
    let carry = ""
    let lineIndex = 0
    const selected: Array<string> = []
    const take = (line: string) => {
      if (lineIndex >= offset && (limit === undefined || selected.length < limit)) {
        selected.push(line)
      }
      lineIndex += 1
    }
    yield* Stream.runForEach(Stream.decodeText(bytes), (chunk) =>
      Effect.sync(() => {
        const parts = splitLines(carry + chunk)
        carry = parts.pop() ?? ""
        for (const line of parts) take(line)
      }),
    )
    take(carry)
    const nextOffset = offset + (limit ?? lineIndex)
    return {
      content: selected.join("\n"),
      totalLines: lineIndex,
      nextOffset: nextOffset < lineIndex ? nextOffset : undefined,
    }
  })

const readLineWindow = (
  filesystem: ExecutionWorldService["filesystem"],
  path: string,
  offset: number,
  limit: number | undefined,
) =>
  windowFromStream(filesystem.stream(path), offset, limit).pipe(
    Effect.catchCause(() =>
      filesystem.readFileString(path).pipe(Effect.map((raw) => windowFromText(raw, offset, limit))),
    ),
  )

/** Resolve an entry returned by readDirectory, which is relative to targetDir. */
const resolveDirectoryEntry = (world: ExecutionWorldService, targetDir: string, entry: string) =>
  world.resolvePath(`${targetDir.replace(/[\\/]$/, "")}/${entry}`)

export const CodingTools = (): Plugin<ExecutionWorld | Truncate> => {
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
      description:
        "Read a UTF-8 text file inside the workspace. Use zero-based offset and limit to inspect a bounded line range; oversized outputs spill to .roop/truncations/.",
      parameters: Schema.Struct({
        path: Schema.String,
        offset: Schema.optionalKey(NonNegativeInt),
        limit: Schema.optionalKey(NonNegativeInt),
      }),
      success: Schema.Struct({
        content: Schema.String,
        truncated: Schema.optional(Schema.Boolean),
        spillPath: Schema.optional(Schema.String),
        hint: Schema.optional(Schema.String),
        lineOffset: Schema.optional(Schema.Finite),
        totalLines: Schema.optional(Schema.Finite),
        nextOffset: Schema.optional(Schema.Finite),
      }),
      failure: ToolFailure,
      failureMode: "return",
      dependencies: [ExecutionWorld, Truncate],
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
        "Search file contents in the workspace for lines matching a regex pattern or literal text (oversized match sets spill to .roop/truncations/)",
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
        output: Schema.optional(Schema.String),
        spillPath: Schema.optional(Schema.String),
        hint: Schema.optional(Schema.String),
      }),
      failure: ToolFailure,
      failureMode: "return",
      dependencies: [ExecutionWorld, Truncate],
    }),
    Tool.make("bash", {
      description:
        "Run a shell command in the workspace and capture stdout, stderr, and exit code (large outputs spill to .roop/truncations/)",
      parameters: Schema.Struct({ command: Schema.String }),
      success: Schema.Struct({
        exitCode: Schema.Finite,
        stdout: Schema.String,
        stderr: Schema.String,
        stdoutTruncated: Schema.optional(Schema.Boolean),
        stderrTruncated: Schema.optional(Schema.Boolean),
        spillPath: Schema.optional(Schema.String),
        stdoutSpillPath: Schema.optional(Schema.String),
        stderrSpillPath: Schema.optional(Schema.String),
        stdoutHint: Schema.optional(Schema.String),
        stderrHint: Schema.optional(Schema.String),
      }),
      failure: ToolFailure,
      failureMode: "return",
      dependencies: [ExecutionWorld, Truncate],
    }),
  )

  return Plugin({
    name: "coding-tools",
    toolkit,
    handlers: toolkit.toLayer({
      readFile: ({ path, offset, limit }) =>
        Effect.gen(function* () {
          const world = yield* ExecutionWorld
          const trunc = yield* Truncate
          const file = yield* asFailure(world.resolvePath(path))
          const lineOffset = offset ?? 0
          const windowed = offset !== undefined || limit !== undefined
          const selected = windowed
            ? yield* asFailure(readLineWindow(world.filesystem, file, lineOffset, limit))
            : {
                content: yield* asFailure(world.filesystem.readFileString(file)),
                totalLines: undefined,
                nextOffset: undefined,
              }
          const res = yield* asFailure(
            trunc.truncate(selected.content, {
              key: `file-${path.replaceAll(/[/\\]/g, "_")}`,
              hintContext: `readFile for '${path}'`,
            }),
          )
          const response: ReadFileResult = { content: res.content }
          if (res.truncated) {
            response.truncated = true
            if (res.spillPath !== undefined) response.spillPath = res.spillPath
            if (res.hint !== undefined) response.hint = res.hint
          }
          if (windowed) {
            response.lineOffset = lineOffset
            response.totalLines = selected.totalLines
            if (selected.nextOffset !== undefined) response.nextOffset = selected.nextOffset
          }
          return response
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
          const trunc = yield* Truncate
          const targetDir = yield* asFailure(world.resolvePath(searchPath ?? "."))
          const allFiles: ReadonlyArray<string> = yield* asFailure(
            world.filesystem.readDirectory(targetDir, { recursive: true }),
          )

          const regex = makeGrepRegex(pattern, caseSensitive)
          const matches: Array<GrepMatch> = []
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

          const encodedMatches = JSON.stringify(matches, null, 2)
          const result = yield* asFailure(
            trunc.truncate(encodedMatches, {
              key: "grep-matches",
              hintContext: `grep for '${pattern}'`,
            }),
          )
          if (!result.truncated) {
            return {
              matches,
              totalMatches,
              truncated: totalMatches > matches.length,
            }
          }
          const response: GrepResult = {
            matches: [],
            totalMatches,
            truncated: true,
            output: result.content,
          }
          if (result.spillPath !== undefined) response.spillPath = result.spillPath
          if (result.hint !== undefined) response.hint = result.hint
          return response
        }),
      bash: ({ command }) =>
        Effect.scoped(
          Effect.gen(function* () {
            const world = yield* ExecutionWorld
            const trunc = yield* Truncate
            const handle = yield* world.spawner.spawn(
              ChildProcess.make(command, {
                shell: true,
                cwd: world.root,
                env: world.env,
              }),
            )
            const [rawStdout, rawStderr, exitCode] = yield* Effect.all(
              [
                Stream.mkString(Stream.decodeText(handle.stdout)),
                Stream.mkString(Stream.decodeText(handle.stderr)),
                handle.exitCode,
              ],
              { concurrency: "unbounded" },
            )
            const { stdout, stderr } = yield* trunc.truncateCommand(command, rawStdout, rawStderr)
            const spillPath = stdout.spillPath ?? stderr.spillPath
            const response: BashResult = {
              exitCode: Number(exitCode),
              stdout: stdout.content,
              stderr: stderr.content,
            }
            if (stdout.truncated) response.stdoutTruncated = true
            if (stderr.truncated) response.stderrTruncated = true
            if (spillPath !== undefined) response.spillPath = spillPath
            if (stdout.spillPath !== undefined) response.stdoutSpillPath = stdout.spillPath
            if (stderr.spillPath !== undefined) response.stderrSpillPath = stderr.spillPath
            if (stdout.hint !== undefined) response.stdoutHint = stdout.hint
            if (stderr.hint !== undefined) response.stderrHint = stderr.hint
            return response
          }).pipe(Effect.mapError((error: any) => new ToolFailure({ message: error.message }))),
        ),
    }),
  })
}
