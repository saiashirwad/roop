import { patchChunks } from "./HunkMatcher.ts"
import { LineScanner } from "./LineScanner.ts"
import { parseHunksFromScanner } from "./OpenAiPatch.ts"
import type { FilePatch } from "./types.ts"

export const normalizeDiffPath = (path: string): string => {
  if (path === "/dev/null" || path === "dev/null") return "/dev/null"
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2)
  return path
}

const parseHeaderPath = (line: string, prefix: "--- " | "+++ "): string => {
  let body = line.slice(prefix.length).trim()
  const tabIndex = body.indexOf("\t")
  if (tabIndex !== -1) {
    body = body.slice(0, tabIndex)
  }
  body = body.replace(/\s+\d{4}-\d{2}-\d{2}.*$/, "")
  return normalizeDiffPath(body.trim())
}

const parseDiffGitPaths = (line: string): readonly [string, string] | undefined => {
  const match = line.match(/^diff --git a\/(.+) b\/(.+)$/)
  return match ? [match[1]!, match[2]!] : undefined
}

export const hasDiffHeaders = (lines: ReadonlyArray<string>): boolean =>
  lines.some(
    (line) =>
      line.startsWith("diff --git ") ||
      line.startsWith("--- ") ||
      line.startsWith("rename from ") ||
      line.startsWith("rename to "),
  )

export const parseUnifiedPatch = (text: string): ReadonlyArray<FilePatch> => {
  const lines = text.split("\n")
  const scanner = new LineScanner(lines)
  const out: Array<FilePatch> = []

  while (scanner.hasNext) {
    scanner.skipEmpty()
    if (!scanner.hasNext) break

    let oldPath: string | undefined
    let newPath: string | undefined
    let renameFrom: string | undefined
    let renameTo: string | undefined

    if (scanner.peek()!.startsWith("diff --git ")) {
      const parsedPaths = parseDiffGitPaths(scanner.next()!)
      if (!parsedPaths) {
        throw new Error(
          `applyPatch verification failed: invalid git diff header: ${scanner.peekAt(-1)}`,
        )
      }
      oldPath = parsedPaths[0]
      newPath = parsedPaths[1]
    }

    while (scanner.hasNext) {
      const line = scanner.peek()!
      if (line.startsWith("diff --git ")) break
      if (line.startsWith("rename from ")) {
        renameFrom = line.slice("rename from ".length).trim()
        scanner.next()
        continue
      }
      if (line.startsWith("rename to ")) {
        renameTo = line.slice("rename to ".length).trim()
        scanner.next()
        continue
      }
      if (line.startsWith("--- ")) {
        oldPath = parseHeaderPath(scanner.next()!, "--- ")
        if (!scanner.hasNext || !scanner.peek()!.startsWith("+++ ")) {
          throw new Error("applyPatch verification failed: missing new file header")
        }
        newPath = parseHeaderPath(scanner.next()!, "+++ ")
        break
      }
      if (line.startsWith("@@")) break
      scanner.next()
    }

    const chunks = parseHunksFromScanner(scanner)
    const fromPath = normalizeDiffPath(renameFrom ?? oldPath ?? "/dev/null")
    const toPath = normalizeDiffPath(renameTo ?? newPath ?? fromPath)

    if (fromPath === "/dev/null") {
      if (toPath === "/dev/null") {
        throw new Error(
          "applyPatch verification failed: invalid diff: both file paths are /dev/null",
        )
      }
      out.push({
        type: "add",
        path: toPath,
        content: patchChunks(toPath, "", chunks),
      })
      continue
    }

    if (toPath === "/dev/null") {
      out.push({
        type: "delete",
        path: fromPath,
      })
      continue
    }

    if (chunks.length === 0 && fromPath === toPath) {
      throw new Error(`applyPatch verification failed: no hunks found for ${fromPath}`)
    }

    const patch: FilePatch = {
      type: "update",
      path: fromPath,
      chunks,
    }
    if (toPath !== fromPath) {
      Object.assign(patch, { movePath: toPath })
    }
    out.push(patch)
  }

  if (out.length === 0) {
    throw new Error("applyPatch verification failed: no hunks found")
  }

  return out
}
