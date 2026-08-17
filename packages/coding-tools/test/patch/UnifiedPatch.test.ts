import { describe, expect, it } from "@effect/vitest"

import { parseUnifiedPatch } from "../../src/patch/UnifiedPatch.ts"

describe("UnifiedPatch", () => {
  it("strips space-separated ISO timestamps from diff headers", () => {
    const text = [
      "--- src/file.ts 2026-08-17 12:00:00.000000000 +0000",
      "+++ src/file.ts 2026-08-17 12:05:00.000000000 +0000",
      "@@ -1,2 +1,2 @@",
      "-old",
      "+new",
      " keep",
    ].join("\n")

    const patches = parseUnifiedPatch(text)
    expect(patches.length).toBe(1)
    expect(patches[0]!.type).toBe("update")
    expect(patches[0]!.path).toBe("src/file.ts")
  })

  it("handles tab-separated timestamps in diff headers", () => {
    const text = [
      "--- a/src/app.ts\t2026-08-17 00:00:00",
      "+++ b/src/app.ts\t2026-08-17 00:01:00",
      "@@ -1 +1 @@",
      "-foo",
      "+bar",
    ].join("\n")

    const patches = parseUnifiedPatch(text)
    expect(patches.length).toBe(1)
    expect(patches[0]!.path).toBe("src/app.ts")
  })
})
