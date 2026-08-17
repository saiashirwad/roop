import { LineScanner } from "./LineScanner.ts"
import type { Chunk, FilePatch } from "./types.ts"

const BEGIN = "*** Begin Patch"
const END = "*** End Patch"
const ADD = "*** Add File:"
const DELETE = "*** Delete File:"
const MOVE = "*** Move to:"
const UPDATE = "*** Update File:"

export const parseHunkHeader = (line: string): string | undefined => {
  if (line === "@@") return undefined
  const unified = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@(?:\s?(.*))?$/)
  if (unified) {
    const ctx = unified[1]?.trim()
    return ctx === undefined || ctx.length === 0 ? undefined : ctx
  }
  const ctx = line.slice(2).trim()
  return ctx.length === 0 ? undefined : ctx
}

export const parseHunksFromScanner = (scanner: LineScanner): ReadonlyArray<Chunk> => {
  const chunks: Array<Chunk> = []

  while (scanner.hasNext) {
    const line = scanner.peek()!
    if (line.startsWith("***") || line.startsWith("diff --git ")) {
      break
    }
    if (!line.startsWith("@@")) {
      scanner.next()
      continue
    }

    const ctx = parseHunkHeader(scanner.next()!)
    const oldLines: Array<string> = []
    const nextLines: Array<string> = []
    let eof = false

    while (scanner.hasNext) {
      const hunkLine = scanner.peek()!
      if (hunkLine === "*** End of File") {
        eof = true
        scanner.next()
        break
      }
      if (
        hunkLine.startsWith("@@") ||
        hunkLine.startsWith("***") ||
        hunkLine.startsWith("diff --git ")
      ) {
        break
      }
      scanner.next()
      if (hunkLine === "") {
        oldLines.push("")
        nextLines.push("")
      } else if (hunkLine.startsWith(" ")) {
        const text = hunkLine.slice(1)
        oldLines.push(text)
        nextLines.push(text)
      } else if (hunkLine.startsWith("-")) {
        oldLines.push(hunkLine.slice(1))
      } else if (hunkLine.startsWith("+")) {
        nextLines.push(hunkLine.slice(1))
      }
    }

    const chunk: Chunk = {
      old: oldLines,
      next: nextLines,
    }
    if (ctx !== undefined) {
      Object.assign(chunk, { ctx })
    }
    if (eof) {
      Object.assign(chunk, { eof: true })
    }
    chunks.push(chunk)
  }

  return chunks
}

export const parseAddLines = (scanner: LineScanner): string => {
  const out: Array<string> = []
  while (scanner.hasNext) {
    const line = scanner.peek()!
    if (line.startsWith("***")) {
      break
    }
    scanner.next()
    if (line.startsWith("+")) {
      out.push(line.slice(1))
    } else if (line === "") {
      out.push("")
    }
  }
  return out.join("\n")
}

export const parseOpenAiPatch = (text: string): ReadonlyArray<FilePatch> => {
  const lines = text.split("\n")
  const beginIdx = lines.findIndex((l) => l === BEGIN)
  if (beginIdx === -1) {
    throw new Error(
      "applyPatch verification failed: Invalid patch format: missing Begin/End markers",
    )
  }
  const explicitEnd = lines.findIndex((l) => l === END)
  const endIdx = explicitEnd === -1 ? lines.length : explicitEnd
  if (beginIdx >= endIdx) {
    throw new Error(
      "applyPatch verification failed: Invalid patch format: missing Begin/End markers",
    )
  }

  const activeLines = lines.slice(beginIdx + 1, endIdx)
  const scanner = new LineScanner(activeLines)
  const out: Array<FilePatch> = []

  while (scanner.hasNext) {
    scanner.skipEmpty()
    if (!scanner.hasNext) break

    const line = scanner.next()!
    if (line.startsWith(ADD)) {
      const path = line.slice(ADD.length).trim()
      if (path.length === 0) {
        throw new Error("applyPatch verification failed: missing add file path")
      }
      const content = parseAddLines(scanner)
      out.push({ type: "add", path, content })
      continue
    }

    if (line.startsWith(DELETE)) {
      const path = line.slice(DELETE.length).trim()
      if (path.length === 0) {
        throw new Error("applyPatch verification failed: missing delete file path")
      }
      out.push({ type: "delete", path })
      continue
    }

    if (line.startsWith(UPDATE)) {
      const path = line.slice(UPDATE.length).trim()
      if (path.length === 0) {
        throw new Error("applyPatch verification failed: missing update file path")
      }

      let movePath: string | undefined
      if (scanner.hasNext && scanner.peek()!.startsWith(MOVE)) {
        const moveLine = scanner.next()!
        movePath = moveLine.slice(MOVE.length).trim()
        if (movePath.length === 0) {
          throw new Error("applyPatch verification failed: missing move file path")
        }
      }

      const chunks = parseHunksFromScanner(scanner)
      if (chunks.length === 0) {
        throw new Error(`applyPatch verification failed: no hunks found for ${path}`)
      }

      const patch: FilePatch = {
        type: "update",
        path,
        chunks,
      }
      if (movePath !== undefined) {
        Object.assign(patch, { movePath })
      }
      out.push(patch)
      continue
    }

    throw new Error(`applyPatch verification failed: unexpected line in patch: ${line}`)
  }

  if (out.length === 0) {
    throw new Error("applyPatch verification failed: no hunks found")
  }

  return out
}
