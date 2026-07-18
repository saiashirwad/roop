import { Effect } from "effect"
import { Toolkit } from "effect/unstable/ai"

import {
  ApplyPatch,
  applyHunks,
  countLines,
  EditFile,
  ListFiles,
  ReadFile,
  WriteFile,
} from "@roop/tools/filesystem.ts"
import type { ToolFailure } from "@roop/tools/failure.ts"
import { isIgnoredPath } from "@roop/tools/workspace.ts"

/**
 * The room's shared virtual filesystem: flat map of posix-style relative
 * paths to text content. Directories are implicit. `..` may not escape root.
 */
export type FileStorage = {
  readonly get: (path: string) => string | undefined
  readonly put: (path: string, content: string) => void
  readonly delete: (path: string) => boolean
  /** All file paths, sorted. */
  readonly list: () => Array<string>
}

export const FILES_SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`

export const sqliteFileStorage = (sql: SqlStorage): FileStorage => ({
  get: (path) => {
    const row = sql.exec("SELECT content FROM files WHERE path = ?", path).toArray()[0] as
      | { content: string }
      | undefined
    return row?.content
  },
  put: (path, content) => {
    sql.exec(
      "INSERT OR REPLACE INTO files (path, content, updated_at) VALUES (?, ?, ?)",
      path,
      content,
      Date.now(),
    )
  },
  delete: (path) => {
    const existed = sql.exec("SELECT 1 AS x FROM files WHERE path = ?", path).toArray().length > 0
    sql.exec("DELETE FROM files WHERE path = ?", path)
    return existed
  },
  list: () =>
    sql
      .exec("SELECT path FROM files ORDER BY path")
      .toArray()
      .map((row) => (row as { path: string }).path),
})

/** In-memory variant for tests. */
export const memoryFileStorage = (): FileStorage => {
  const map = new Map<string, string>()
  return {
    get: (path) => map.get(path),
    put: (path, content) => {
      map.set(path, content)
    },
    delete: (path) => map.delete(path),
    list: () => [...map.keys()].sort(),
  }
}

/** Returns the normalized relative path ("" = workspace root), or undefined if it escapes root. */
export const normalizePath = (raw: string): string | undefined => {
  const parts: Array<string> = []
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      if (parts.length === 0) return undefined
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  return parts.join("/")
}

const fail = (message: string, reason: string): Effect.Effect<never, ToolFailure> =>
  Effect.fail({ message, reason } satisfies ToolFailure)

const invalidPath = (raw: string) => fail(`Invalid path (escapes workspace): ${raw}`, "InvalidInput")

const LIST_CAP = 200

/** Tool handlers over FileStorage — same shapes as @roop/tools fileSystemHandlers. */
export const fakeFsHandlers = (files: FileStorage) => ({
  readFile: Effect.fn("fakefs/readFile")(function* ({ path }: { path: string }) {
    const normalized = normalizePath(path)
    if (normalized === undefined || normalized === "") {
      return yield* invalidPath(path)
    }
    const content = files.get(normalized)
    if (content === undefined) {
      return yield* fail(`File not found: ${normalized}`, "NotFound")
    }
    return { path: normalized, content }
  }),

  listFiles: Effect.fn("fakefs/listFiles")(function* ({
    path,
    recursive,
  }: {
    path: string
    recursive: boolean
  }) {
    const normalized = normalizePath(path)
    if (normalized === undefined) {
      return yield* invalidPath(path)
    }
    const effectiveRecursive = normalized === "" ? false : recursive
    const prefix = normalized === "" ? "" : `${normalized}/`
    const visible = files.list().filter((entry) => !isIgnoredPath(entry))
    const under = visible.filter((entry) => entry.startsWith(prefix))

    if (normalized !== "" && under.length === 0 && files.get(normalized) === undefined) {
      return yield* fail(`Directory not found: ${normalized}`, "NotFound")
    }

    let entries: Array<string>
    if (effectiveRecursive) {
      entries = under
    } else {
      const children = new Set<string>()
      for (const entry of under) {
        const rest = entry.slice(prefix.length)
        const slash = rest.indexOf("/")
        children.add(slash === -1 ? rest : `${rest.slice(0, slash)}/`)
      }
      entries = [...children].sort()
    }

    const capped = entries.slice(0, LIST_CAP)
    return {
      path: normalized === "" ? "." : normalized,
      recursive: effectiveRecursive,
      entries: capped,
      totalEntries: entries.length,
      truncated: entries.length > capped.length,
    }
  }),

  writeFile: Effect.fn("fakefs/writeFile")(function* ({
    path,
    content,
  }: {
    path: string
    content: string
  }) {
    const normalized = normalizePath(path)
    if (normalized === undefined || normalized === "") {
      return yield* invalidPath(path)
    }
    const created = files.get(normalized) === undefined
    files.put(normalized, content)
    return { path: normalized, bytesWritten: content.length, created }
  }),

  editFile: Effect.fn("fakefs/editFile")(function* ({
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
    const normalized = normalizePath(path)
    if (normalized === undefined || normalized === "") {
      return yield* invalidPath(path)
    }
    if (oldString.length === 0) {
      return yield* fail("oldString must not be empty", "InvalidInput")
    }
    const content = files.get(normalized)
    if (content === undefined) {
      return yield* fail(`File not found: ${normalized}`, "NotFound")
    }
    const occurrences = content.split(oldString).length - 1
    if (occurrences === 0) {
      return yield* fail(`oldString not found in ${normalized}`, "NotFound")
    }
    const shouldReplaceAll = replaceAll === true
    if (!shouldReplaceAll && occurrences > 1) {
      return yield* fail(
        `oldString found ${occurrences} times in ${normalized}; pass replaceAll true or use a more specific match`,
        "Ambiguous",
      )
    }
    const replacements = shouldReplaceAll ? occurrences : 1
    const next = shouldReplaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString)
    files.put(normalized, next)
    return {
      path: normalized,
      replacements,
      linesRemoved: countLines(oldString) * replacements,
      linesAdded: countLines(newString) * replacements,
    }
  }),

  applyPatch: Effect.fn("fakefs/applyPatch")(function* ({
    path,
    mode,
    hunks,
    content,
  }: {
    path: string
    mode?: "update" | "create" | "delete" | null | undefined
    hunks?: ReadonlyArray<{ oldText: string; newText: string }> | null | undefined
    content?: string | null | undefined
  }) {
    const normalized = normalizePath(path)
    if (normalized === undefined || normalized === "") {
      return yield* invalidPath(path)
    }
    const resolvedMode = mode === "create" || mode === "delete" ? mode : "update"

    if (resolvedMode === "create") {
      if (content === null || content === undefined) {
        return yield* fail("create mode requires content", "InvalidInput")
      }
      if (files.get(normalized) !== undefined) {
        return yield* fail(
          `${normalized} already exists; use mode update (hunks) or writeFile to overwrite`,
          "AlreadyExists",
        )
      }
      files.put(normalized, content)
      return {
        path: normalized,
        mode: "create" as const,
        hunksApplied: 0,
        linesRemoved: 0,
        linesAdded: countLines(content),
      }
    }

    if (resolvedMode === "delete") {
      const previous = files.get(normalized)
      if (previous === undefined) {
        return yield* fail(`${normalized} does not exist`, "NotFound")
      }
      files.delete(normalized)
      return {
        path: normalized,
        mode: "delete" as const,
        hunksApplied: 0,
        linesRemoved: countLines(previous),
        linesAdded: 0,
      }
    }

    const before = files.get(normalized)
    if (before === undefined) {
      return yield* fail(`File not found: ${normalized}`, "NotFound")
    }
    const applied = applyHunks(before, hunks ?? [])
    if (!applied.ok) {
      return yield* fail(applied.error.message, applied.error.reason)
    }
    if (applied.value.content !== before) {
      files.put(normalized, applied.value.content)
    }
    return {
      path: normalized,
      mode: "update" as const,
      hunksApplied: applied.value.hunksApplied,
      linesRemoved: applied.value.linesRemoved,
      linesAdded: applied.value.linesAdded,
    }
  }),
})

export const FakeFsToolkit = Toolkit.make(ReadFile, ListFiles, WriteFile, EditFile, ApplyPatch)
