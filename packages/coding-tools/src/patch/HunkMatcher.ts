import type { Chunk } from "./types.ts"

export const normalizeUnicode = (line: string): string =>
  line
    .replace(/[\u2018\u2019\u201A\u201B\u00B4]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/[\u00A0\u2000-\u200B\u202F\u205F\u3000\uFEFF]/g, " ")

const match = (
  lines: ReadonlyArray<string>,
  part: ReadonlyArray<string>,
  from: number,
  same: (left: string, right: string) => boolean,
  eof: boolean,
): number => {
  if (eof) {
    const last = lines.length - part.length
    if (last >= from) {
      let ok = true
      for (let i = 0; i < part.length; i++) {
        if (!same(lines[last + i]!, part[i]!)) {
          ok = false
          break
        }
      }
      if (ok) return last
    }
  }

  for (let i = from; i <= lines.length - part.length; i++) {
    let ok = true
    for (let j = 0; j < part.length; j++) {
      if (!same(lines[i + j]!, part[j]!)) {
        ok = false
        break
      }
    }
    if (ok) return i
  }

  return -1
}

export const seek = (
  lines: ReadonlyArray<string>,
  part: ReadonlyArray<string>,
  from: number,
  eof = false,
): number => {
  if (part.length === 0) return -1

  // Tier 1: Exact match
  const exact = match(lines, part, from, (l, r) => l === r, eof)
  if (exact !== -1) return exact

  // Tier 2: trimEnd()
  const rstrip = match(lines, part, from, (l, r) => l.trimEnd() === r.trimEnd(), eof)
  if (rstrip !== -1) return rstrip

  // Tier 3: trim()
  const trim = match(lines, part, from, (l, r) => l.trim() === r.trim(), eof)
  if (trim !== -1) return trim

  // Tier 4: normalizeUnicode()
  return match(
    lines,
    part,
    from,
    (l, r) => normalizeUnicode(l.trim()) === normalizeUnicode(r.trim()),
    eof,
  )
}

export const computeHunkSplices = (
  file: string,
  lines: ReadonlyArray<string>,
  chunks: ReadonlyArray<Chunk>,
): ReadonlyArray<readonly [number, number, ReadonlyArray<string>]> => {
  const out: Array<readonly [number, number, ReadonlyArray<string>]> = []
  let from = 0

  for (const chunk of chunks) {
    if (chunk.ctx) {
      const at = seek(lines, [chunk.ctx], from)
      if (at === -1) {
        throw new Error(
          `applyPatch verification failed: Failed to find context '${chunk.ctx}' in ${file}`,
        )
      }
      from = at + 1
    }

    if (chunk.old.length === 0) {
      out.push([chunk.ctx ? from : lines.length, 0, chunk.next])
      continue
    }

    let old = chunk.old
    let next = chunk.next
    let at = seek(lines, old, from, chunk.eof === true)
    if (at === -1 && old.at(-1) === "") {
      old = old.slice(0, -1)
      next = next.at(-1) === "" ? next.slice(0, -1) : next
      at = seek(lines, old, from, chunk.eof === true)
    }
    if (at === -1) {
      throw new Error(
        `applyPatch verification failed: Failed to find expected lines in ${file}:\n${chunk.old.join("\n")}`,
      )
    }

    out.push([at, old.length, next])
    from = at + old.length
  }

  return [...out].sort((a, b) => a[0] - b[0])
}

export const patchChunks = (file: string, input: string, chunks: ReadonlyArray<Chunk>): string => {
  const eol = input.includes("\r\n") ? "\r\n" : "\n"
  const lines = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
  if (lines.at(-1) === "") {
    lines.pop()
  }

  const out = [...lines]
  for (const [at, size, next] of computeHunkSplices(file, lines, chunks).toReversed()) {
    out.splice(at, size, ...next)
  }

  if (out.at(-1) !== "") {
    out.push("")
  }

  const text = out.join("\n")
  return eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text
}
