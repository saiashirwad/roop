import { describe, expect, it } from "@effect/vitest"

import { normalizeUnicode, patchChunks, seek } from "../../src/patch/HunkMatcher.ts"

describe("HunkMatcher", () => {
  it("normalizes smart quotes, dashes, and unicode spaces", () => {
    expect(normalizeUnicode("“hello” ‘world’ — test…\u00A0end")).toBe(
      "\"hello\" 'world' - test... end",
    )
  })

  it("seeks across 4 fuzzy tiers", () => {
    const lines = ["const a = 1", "const b = 2  ", "  const c = 3", "const d = “foo”"]

    // Tier 1: exact
    expect(seek(lines, ["const a = 1"], 0)).toBe(0)

    // Tier 2: trailing whitespace
    expect(seek(lines, ["const b = 2"], 0)).toBe(1)

    // Tier 3: indentation drift
    expect(seek(lines, ["const c = 3"], 0)).toBe(2)

    // Tier 4: unicode normalization
    expect(seek(lines, ['const d = "foo"'], 0)).toBe(3)
  })

  it("preserves CRLF line endings when patching", () => {
    const input = "alpha\r\nbeta\r\ngamma\r\n"
    const patched = patchChunks("test.txt", input, [
      {
        old: ["beta"],
        next: ["delta"],
      },
    ])
    expect(patched).toBe("alpha\r\ndelta\r\ngamma\r\n")
  })

  it("inserts pure addition at anchor context position", () => {
    const input = "function start() {}\nfunction middle() {}\nfunction end() {}\n"
    const patched = patchChunks("test.txt", input, [
      {
        ctx: "function middle() {}",
        old: [],
        next: ["// inserted after middle", "function injected() {}"],
      },
    ])
    expect(patched).toBe(
      "function start() {}\nfunction middle() {}\n// inserted after middle\nfunction injected() {}\nfunction end() {}\n",
    )
  })
})
