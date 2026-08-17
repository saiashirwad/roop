import { Effect } from "effect"

import { type ExecutionWorldService, normalizeWorkspacePath } from "../ExecutionWorld.ts"
import { ToolFailure } from "../ToolFailure.ts"
import { normalizePatchText } from "./ExtractBlock.ts"
import { patchChunks } from "./HunkMatcher.ts"
import { LineScanner } from "./LineScanner.ts"
import { parseHunksFromScanner, parseOpenAiPatch } from "./OpenAiPatch.ts"
import type { ApplyPatchResult, Chunk, FilePatch, StagedOperation } from "./types.ts"
import { hasDiffHeaders, parseUnifiedPatch } from "./UnifiedPatch.ts"

export * from "./ExtractBlock.ts"
export * from "./HunkMatcher.ts"
export * from "./LineScanner.ts"
export * from "./OpenAiPatch.ts"
export * from "./types.ts"
export * from "./UnifiedPatch.ts"

export const parsePatch = (input: string): ReadonlyArray<FilePatch> => {
  const text = normalizePatchText(input)
  if (text.length === 0) {
    throw new Error("applyPatch verification failed: patchText is required")
  }
  if (text === "*** Begin Patch\n*** End Patch" || text === "*** Begin Patch") {
    throw new Error("applyPatch verification failed: patch rejected: empty patch")
  }

  if (text.startsWith("*** Begin Patch")) {
    return parseOpenAiPatch(text)
  }

  const lines = text.split("\n")
  if (hasDiffHeaders(lines)) {
    return parseUnifiedPatch(text)
  }

  throw new Error(
    "applyPatch verification failed: Invalid patch format: expected git/unified diff or *** Begin Patch block",
  )
}

const parseSingleWrappedOrRaw = (input: string): ReadonlyArray<Chunk> => {
  const text = normalizePatchText(input)
  if (text.length === 0) {
    throw new Error("applyPatch verification failed: patchText is required")
  }
  if (text === "*** Begin Patch\n*** End Patch" || text === "*** Begin Patch") {
    throw new Error("applyPatch verification failed: patch rejected: empty patch")
  }

  if (text.startsWith("*** Begin Patch")) {
    const patches = parsePatch(text)
    if (patches.length !== 1 || patches[0]!.type !== "update") {
      throw new Error(
        "applyPatch verification failed: only single-file update patches are supported in patchContent",
      )
    }
    return patches[0]!.chunks
  }

  const scanner = new LineScanner(text.split("\n"))
  const chunks = parseHunksFromScanner(scanner)
  if (chunks.length === 0) {
    throw new Error("applyPatch verification failed: no hunks found")
  }
  return chunks
}

export const patchContent = (file: string, input: string, patchText: string): string =>
  patchChunks(file, input, parseSingleWrappedOrRaw(patchText))

const dirname = (filePath: string): string => {
  const normalized = filePath.replaceAll("\\", "/")
  const lastSlash = normalized.lastIndexOf("/")
  return lastSlash === -1 ? "." : normalized.slice(0, lastSlash)
}

export const applyPatchTransaction = (
  world: ExecutionWorldService,
  patchText: string,
): Effect.Effect<ApplyPatchResult, ToolFailure> =>
  Effect.gen(function* () {
    const patches = yield* Effect.try({
      try: () => parsePatch(patchText),
      catch: (err: any) =>
        new ToolFailure({
          message: err?.message ?? String(err),
        }),
    })

    const state = new Map<string, string | null>()
    const operations: Array<StagedOperation> = []
    const summaryLines: Array<string> = []
    const touchedFiles: Array<string> = []

    const resolveWorkspacePath = (rawPath: string) =>
      Effect.gen(function* () {
        const fullPath = yield* world
          .resolvePath(rawPath)
          .pipe(
            Effect.mapError(
              (err: any) => new ToolFailure({ message: err?.message ?? String(err) }),
            ),
          )
        const relPath = normalizeWorkspacePath(world, fullPath)
        return { fullPath, relPath }
      })

    const loadContent = (
      fullPath: string,
      relPath: string,
      action: "update" | "delete",
    ): Effect.Effect<string, ToolFailure> =>
      Effect.gen(function* () {
        if (state.has(fullPath)) {
          const staged = state.get(fullPath)
          if (staged === null) {
            return yield* new ToolFailure({
              message: `cannot ${action} '${relPath}': file is deleted in this patch`,
            })
          }
          if (staged !== undefined) {
            return staged
          }
        }
        const exists = yield* world.filesystem
          .exists(fullPath)
          .pipe(Effect.mapError((err) => new ToolFailure({ message: String(err) })))
        if (!exists) {
          return yield* new ToolFailure({
            message: `cannot ${action} '${relPath}': file does not exist`,
          })
        }
        const diskContent = yield* world.filesystem
          .readFileString(fullPath)
          .pipe(Effect.mapError((err) => new ToolFailure({ message: String(err) })))
        state.set(fullPath, diskContent)
        return diskContent
      })

    // Phase 1: Staging
    for (const patch of patches) {
      if (patch.type === "add") {
        const { fullPath, relPath } = yield* resolveWorkspacePath(patch.path)
        state.set(fullPath, patch.content)
        operations.push({
          type: "add",
          relPath,
          fullPath,
          content: patch.content,
        })
        summaryLines.push(`+ ${relPath}`)
        touchedFiles.push(relPath)
        continue
      }

      if (patch.type === "delete") {
        const { fullPath, relPath } = yield* resolveWorkspacePath(patch.path)
        yield* loadContent(fullPath, relPath, "delete")
        state.set(fullPath, null)
        operations.push({
          type: "delete",
          relPath,
          fullPath,
        })
        summaryLines.push(`- ${relPath}`)
        touchedFiles.push(relPath)
        continue
      }

      if (patch.type === "update") {
        const fromResolved = yield* resolveWorkspacePath(patch.path)
        const currentContent = yield* loadContent(
          fromResolved.fullPath,
          fromResolved.relPath,
          "update",
        )
        const nextContent = yield* Effect.try({
          try: () => patchChunks(fromResolved.relPath, currentContent, patch.chunks),
          catch: (err: any) =>
            new ToolFailure({
              message: err?.message ?? String(err),
            }),
        })

        if (patch.movePath !== undefined) {
          const toResolved = yield* resolveWorkspacePath(patch.movePath)
          state.set(fromResolved.fullPath, null)
          state.set(toResolved.fullPath, nextContent)
          operations.push({
            type: "move",
            fromRelPath: fromResolved.relPath,
            fromFullPath: fromResolved.fullPath,
            toRelPath: toResolved.relPath,
            toFullPath: toResolved.fullPath,
            content: nextContent,
          })
          summaryLines.push(`M ${fromResolved.relPath} -> ${toResolved.relPath}`)
          touchedFiles.push(toResolved.relPath)
          continue
        }

        state.set(fromResolved.fullPath, nextContent)
        operations.push({
          type: "update",
          relPath: fromResolved.relPath,
          fullPath: fromResolved.fullPath,
          content: nextContent,
        })
        summaryLines.push(`M ${fromResolved.relPath}`)
        touchedFiles.push(fromResolved.relPath)
      }
    }

    // Phase 2: Commit
    for (const op of operations) {
      if (op.type === "add" || op.type === "update") {
        const dir = dirname(op.fullPath)
        yield* world.filesystem
          .makeDirectory(dir, { recursive: true })
          .pipe(Effect.mapError((err) => new ToolFailure({ message: String(err) })))
        const fileContent =
          op.content.length > 0 && !op.content.endsWith("\n") ? `${op.content}\n` : op.content
        yield* world.filesystem
          .writeFileString(op.fullPath, fileContent)
          .pipe(Effect.mapError((err) => new ToolFailure({ message: String(err) })))
        continue
      }

      if (op.type === "move") {
        const dir = dirname(op.toFullPath)
        yield* world.filesystem
          .makeDirectory(dir, { recursive: true })
          .pipe(Effect.mapError((err) => new ToolFailure({ message: String(err) })))
        const fileContent =
          op.content.length > 0 && !op.content.endsWith("\n") ? `${op.content}\n` : op.content
        yield* world.filesystem
          .writeFileString(op.toFullPath, fileContent)
          .pipe(Effect.mapError((err) => new ToolFailure({ message: String(err) })))
        const fromExists = yield* world.filesystem
          .exists(op.fromFullPath)
          .pipe(Effect.mapError((err) => new ToolFailure({ message: String(err) })))
        if (fromExists) {
          yield* world.filesystem
            .remove(op.fromFullPath)
            .pipe(Effect.mapError((err) => new ToolFailure({ message: String(err) })))
        }
        continue
      }

      if (op.type === "delete") {
        const exists = yield* world.filesystem
          .exists(op.fullPath)
          .pipe(Effect.mapError((err) => new ToolFailure({ message: String(err) })))
        if (exists) {
          yield* world.filesystem
            .remove(op.fullPath)
            .pipe(Effect.mapError((err) => new ToolFailure({ message: String(err) })))
        }
      }
    }

    return {
      summary: summaryLines.join("\n"),
      files: touchedFiles,
    }
  })
