import { Effect, FileSystem, Path, Schema } from "effect"
import { Tool } from "effect/unstable/ai"

import { ToolFailure, toToolFailure } from "./failure.ts"
import { isTrue, llmOptional } from "./params.ts"
import { isIgnoredPath } from "./workspace.ts"

export const ReadFile = Tool.make("readFile", {
  description: "Read a text file from the current workspace",
  parameters: Schema.Struct({
    path: Schema.String.annotate({
      description: "Relative file path to read, eg package.json, or src/main.ts",
    }),
  }),
  success: Schema.Struct({
    path: Schema.String,
    content: Schema.String,
  }),
  failure: ToolFailure,
  failureMode: "return",
})

export const ListFiles = Tool.make("listFiles", {
  description:
    "List files in a directory in the current workspace. Results are capped and omit dependency/vendor directories.",
  parameters: Schema.Struct({
    path: Schema.String.annotate({
      description:
        "Relative directory path to list. Use . for the workspace root, or src, test, etc.",
    }),
    recursive: Schema.Boolean.annotate({
      description:
        "Whether to recursively list nested files and directories. Use false unless explicitly asked.",
    }),
  }),
  success: Schema.Struct({
    path: Schema.String,
    recursive: Schema.Boolean,
    entries: Schema.Array(Schema.String),
    totalEntries: Schema.Number,
    truncated: Schema.Boolean,
  }),
  failure: ToolFailure,
  failureMode: "return",
})

export const WriteFile = Tool.make("writeFile", {
  description:
    "Write full text content to a file (create or overwrite). Prefer applyPatch for multi-hunk edits to existing files, and editFile for a single small swap. Creates parent directories when needed.",
  parameters: Schema.Struct({
    path: Schema.String.annotate({
      description: "Relative file path to write, eg src/utils.ts",
    }),
    content: Schema.String.annotate({
      description: "Full file contents to write",
    }),
  }),
  success: Schema.Struct({
    path: Schema.String,
    bytesWritten: Schema.Number,
    created: Schema.Boolean,
  }),
  failure: ToolFailure,
  failureMode: "return",
})

export const EditFile = Tool.make("editFile", {
  description:
    "Replace a single exact text match in a file. Prefer applyPatch for multi-hunk edits. Fails if the old text is missing, or appears more than once unless replaceAll is true.",
  parameters: Schema.Struct({
    path: Schema.String.annotate({
      description: "Relative file path to edit",
    }),
    oldString: Schema.String.annotate({
      description: "Exact text to find in the file",
    }),
    newString: Schema.String.annotate({
      description: "Replacement text",
    }),
    replaceAll: llmOptional(
      Schema.Boolean.annotate({
        description: "Replace every occurrence. Defaults to false (exactly one match required).",
      }),
    ),
  }),
  success: Schema.Struct({
    path: Schema.String,
    replacements: Schema.Number,
    linesRemoved: Schema.Number,
    linesAdded: Schema.Number,
  }),
  failure: ToolFailure,
  failureMode: "return",
})

export const PatchHunk = Schema.Struct({
  oldText: Schema.String.annotate({
    description:
      "Exact text to find (must match once in the file as it stands when this hunk runs). Include enough surrounding lines for uniqueness.",
  }),
  newText: Schema.String.annotate({
    description: "Replacement text. Use an empty string to delete the oldText region.",
  }),
})

export type PatchHunk = typeof PatchHunk.Type

export const ApplyPatch = Tool.make("applyPatch", {
  description:
    "Apply structured patches to a workspace file (Codex-style). Preferred for multi-hunk updates to existing files. Modes: update (default) applies ordered exact-match hunks; create writes a new file from content; delete removes a file. Each update hunk's oldText must match exactly once (strict — no fuzzy apply). Prefer writeFile only for full-file rewrites; prefer editFile for one tiny swap.",
  parameters: Schema.Struct({
    path: Schema.String.annotate({
      description: "Relative file path, eg src/utils.ts",
    }),
    mode: llmOptional(
      Schema.Literals(["update", "create", "delete"]).annotate({
        description:
          "update (default): apply hunks to an existing file. create: write content to a new path. delete: remove the file.",
      }),
    ),
    hunks: llmOptional(
      Schema.Array(PatchHunk).annotate({
        description:
          "Required for update mode. Applied in order; later hunks see earlier replacements. Each oldText must appear exactly once.",
      }),
    ),
    content: llmOptional(
      Schema.String.annotate({
        description: "Required for create mode: full new file body.",
      }),
    ),
  }),
  success: Schema.Struct({
    path: Schema.String,
    mode: Schema.Literals(["update", "create", "delete"]),
    hunksApplied: Schema.Number,
    linesRemoved: Schema.Number,
    linesAdded: Schema.Number,
  }),
  failure: ToolFailure,
  failureMode: "return",
})

export const countLines = (text: string): number =>
  text.length === 0 ? 0 : text.split("\n").length

export type PatchHunkInput = {
  readonly oldText: string
  readonly newText: string
}

export type ApplyHunksOk = {
  readonly content: string
  readonly hunksApplied: number
  readonly linesRemoved: number
  readonly linesAdded: number
}

export type ApplyHunksErr = {
  readonly message: string
  readonly reason: "InvalidInput" | "NotFound" | "Ambiguous"
}

export const applyHunks = (
  content: string,
  hunks: ReadonlyArray<PatchHunkInput>,
):
  | { readonly ok: true; readonly value: ApplyHunksOk }
  | { readonly ok: false; readonly error: ApplyHunksErr } => {
  if (hunks.length === 0) {
    return {
      ok: false,
      error: {
        message: "hunks must not be empty for update mode",
        reason: "InvalidInput",
      },
    }
  }

  let current = content
  let linesRemoved = 0
  let linesAdded = 0
  let hunksApplied = 0

  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i]!
    const index = i + 1

    if (hunk.oldText.length === 0) {
      return {
        ok: false,
        error: {
          message: `hunk ${index}: oldText must not be empty (use create mode for new files)`,
          reason: "InvalidInput",
        },
      }
    }

    if (hunk.oldText === hunk.newText) {
      hunksApplied += 1
      continue
    }

    const occurrences = current.split(hunk.oldText).length - 1
    if (occurrences === 0) {
      const preview = hunk.oldText.length > 120 ? `${hunk.oldText.slice(0, 120)}…` : hunk.oldText
      return {
        ok: false,
        error: {
          message: `hunk ${index}: oldText not found in file (strict match). Preview: ${JSON.stringify(preview)}`,
          reason: "NotFound",
        },
      }
    }

    if (occurrences > 1) {
      return {
        ok: false,
        error: {
          message: `hunk ${index}: oldText found ${occurrences} times; include more surrounding context so it matches once`,
          reason: "Ambiguous",
        },
      }
    }

    current = current.replace(hunk.oldText, hunk.newText)
    linesRemoved += countLines(hunk.oldText)
    linesAdded += countLines(hunk.newText)
    hunksApplied += 1
  }

  return {
    ok: true,
    value: {
      content: current,
      hunksApplied,
      linesRemoved,
      linesAdded,
    },
  }
}

const resolvePatchMode = (
  mode: "update" | "create" | "delete" | null | undefined,
): "update" | "create" | "delete" => {
  if (mode === "create" || mode === "delete" || mode === "update") return mode
  return "update"
}

export const fileSystemHandlers = (fs: FileSystem.FileSystem, pathService: Path.Path) => ({
  readFile: Effect.fn("tools/filesystem/readFile")(function* ({ path }: { path: string }) {
    const content = yield* fs.readFileString(path).pipe(Effect.catch(toToolFailure))
    return { path, content }
  }),

  listFiles: Effect.fn("tools/filesystem/listFiles")(function* ({
    path,
    recursive,
  }: {
    path: string
    recursive: boolean
  }) {
    const effectiveRecursive = path === "." ? false : recursive
    const allEntries = yield* fs
      .readDirectory(path, { recursive: effectiveRecursive })
      .pipe(Effect.catch(toToolFailure))
    const entries = allEntries.filter((entry) => !isIgnoredPath(entry)).slice(0, 200)

    return {
      path,
      recursive: effectiveRecursive,
      entries,
      totalEntries: allEntries.length,
      truncated: allEntries.length > entries.length,
    }
  }),

  writeFile: Effect.fn("tools/filesystem/writeFile")(function* ({
    path,
    content,
  }: {
    path: string
    content: string
  }) {
    const exists = yield* fs.exists(path).pipe(Effect.catch(() => Effect.succeed(false)))

    const dir = pathService.dirname(path)
    if (dir !== "" && dir !== ".") {
      yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.catch(toToolFailure))
    }
    yield* fs.writeFileString(path, content).pipe(Effect.catch(toToolFailure))
    return {
      path,
      bytesWritten: content.length,
      created: !exists,
    }
  }),

  editFile: Effect.fn("tools/filesystem/editFile")(function* ({
    path,
    oldString,
    newString,
    replaceAll,
  }: {
    path: string
    oldString: string
    newString: string
    replaceAll?: boolean | null | undefined
  }) {
    if (oldString.length === 0) {
      return yield* Effect.fail({
        message: "oldString must not be empty",
        reason: "InvalidInput",
      } satisfies ToolFailure)
    }

    const content = yield* fs.readFileString(path).pipe(Effect.catch(toToolFailure))
    const occurrences = content.split(oldString).length - 1

    if (occurrences === 0) {
      return yield* Effect.fail({
        message: `oldString not found in ${path}`,
        reason: "NotFound",
      } satisfies ToolFailure)
    }

    const shouldReplaceAll = isTrue(replaceAll)
    if (!shouldReplaceAll && occurrences > 1) {
      return yield* Effect.fail({
        message: `oldString found ${occurrences} times in ${path}; pass replaceAll true or use a more specific match`,
        reason: "Ambiguous",
      } satisfies ToolFailure)
    }

    const replacements = shouldReplaceAll ? occurrences : 1
    const next = shouldReplaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString)

    yield* fs.writeFileString(path, next).pipe(Effect.catch(toToolFailure))
    return {
      path,
      replacements,
      linesRemoved: countLines(oldString) * replacements,
      linesAdded: countLines(newString) * replacements,
    }
  }),

  applyPatch: Effect.fn("tools/filesystem/applyPatch")(function* ({
    path,
    mode,
    hunks,
    content,
  }: {
    path: string
    mode?: "update" | "create" | "delete" | null | undefined
    hunks?: ReadonlyArray<PatchHunkInput> | null | undefined
    content?: string | null | undefined
  }) {
    const resolvedMode = resolvePatchMode(mode)

    if (resolvedMode === "create") {
      if (content === null || content === undefined) {
        return yield* Effect.fail({
          message: "create mode requires content",
          reason: "InvalidInput",
        } satisfies ToolFailure)
      }
      const exists = yield* fs.exists(path).pipe(Effect.catch(() => Effect.succeed(false)))
      if (exists) {
        return yield* Effect.fail({
          message: `${path} already exists; use mode update (hunks) or writeFile to overwrite`,
          reason: "AlreadyExists",
        } satisfies ToolFailure)
      }
      const dir = pathService.dirname(path)
      if (dir !== "" && dir !== ".") {
        yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.catch(toToolFailure))
      }
      yield* fs.writeFileString(path, content).pipe(Effect.catch(toToolFailure))
      return {
        path,
        mode: "create" as const,
        hunksApplied: 0,
        linesRemoved: 0,
        linesAdded: countLines(content),
      }
    }

    if (resolvedMode === "delete") {
      const exists = yield* fs.exists(path).pipe(Effect.catch(() => Effect.succeed(false)))
      if (!exists) {
        return yield* Effect.fail({
          message: `${path} does not exist`,
          reason: "NotFound",
        } satisfies ToolFailure)
      }
      const previous = yield* fs.readFileString(path).pipe(Effect.catch(toToolFailure))
      yield* fs.remove(path).pipe(Effect.catch(toToolFailure))
      return {
        path,
        mode: "delete" as const,
        hunksApplied: 0,
        linesRemoved: countLines(previous),
        linesAdded: 0,
      }
    }

    const hunkList = hunks ?? []
    const contentBefore = yield* fs.readFileString(path).pipe(Effect.catch(toToolFailure))
    const applied = applyHunks(contentBefore, hunkList)
    if (!applied.ok) {
      return yield* Effect.fail({
        message: applied.error.message,
        reason: applied.error.reason,
      } satisfies ToolFailure)
    }

    if (applied.value.content !== contentBefore) {
      yield* fs.writeFileString(path, applied.value.content).pipe(Effect.catch(toToolFailure))
    }

    return {
      path,
      mode: "update" as const,
      hunksApplied: applied.value.hunksApplied,
      linesRemoved: applied.value.linesRemoved,
      linesAdded: applied.value.linesAdded,
    }
  }),
})
