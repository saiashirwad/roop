import { describe, expect, it } from "@effect/vitest"

import { extractPatchBlock, normalizePatchText } from "../../src/patch/ExtractBlock.ts"

describe("ExtractBlock", () => {
  it("extracts block surrounded by conversational text", () => {
    const text = [
      "Sure, here is the patch you asked for:",
      "```diff",
      "*** Begin Patch",
      "*** Add File: test.txt",
      "+hello",
      "*** End Patch",
      "```",
      "Let me know if this works!",
    ].join("\n")

    expect(extractPatchBlock(text)).toBe(
      ["*** Begin Patch", "*** Add File: test.txt", "+hello", "*** End Patch"].join("\n"),
    )
  })

  it("extracts heredoc wrapped in bash script", () => {
    const text = [
      "cat <<'EOF'",
      "*** Begin Patch",
      "*** Add File: test.txt",
      "+hello",
      "*** End Patch",
      "EOF",
    ].join("\n")

    expect(extractPatchBlock(text)).toBe(
      ["*** Begin Patch", "*** Add File: test.txt", "+hello", "*** End Patch"].join("\n"),
    )
  })

  it("extracts heredoc surrounded by conversational text", () => {
    const text = [
      "Here is the diff script:",
      "cat <<'EOF'",
      "*** Begin Patch",
      "*** Add File: test.txt",
      "+hello",
      "*** End Patch",
      "EOF",
      "Run the above command to apply.",
    ].join("\n")

    expect(extractPatchBlock(text)).toBe(
      ["*** Begin Patch", "*** Add File: test.txt", "+hello", "*** End Patch"].join("\n"),
    )
  })

  it("normalizes CRLF and whitespace", () => {
    const text = "*** Begin Patch\r\n*** Add File: test.txt\r\n+hello\r\n*** End Patch"
    expect(normalizePatchText(text)).toBe(
      "*** Begin Patch\n*** Add File: test.txt\n+hello\n*** End Patch",
    )
  })
})
