import { describe, expect, it } from "@effect/vitest"

import { parseOpenAiPatch } from "../../src/patch/OpenAiPatch.ts"

describe("OpenAiPatch", () => {
  it("preserves empty context lines in hunks", () => {
    const text = [
      "*** Begin Patch",
      "*** Update File: src/example.ts",
      "@@",
      " const first = 1",
      "",
      "-const old = 2",
      "+const new = 2",
      "*** End Patch",
    ].join("\n")

    const patches = parseOpenAiPatch(text)
    expect(patches.length).toBe(1)
    expect(patches[0]!.type).toBe("update")
    /* SAFETY: patches[0].type was verified to be "update". */
    const patch = patches[0] as Extract<(typeof patches)[number], { readonly type: "update" }>
    expect(patch.chunks[0]!.old).toEqual(["const first = 1", "", "const old = 2"])
    expect(patch.chunks[0]!.next).toEqual(["const first = 1", "", "const new = 2"])
  })

  it("preserves blank lines in added files", () => {
    const text = [
      "*** Begin Patch",
      "*** Add File: src/blank.ts",
      "+const a = 1",
      "",
      "+const b = 2",
      "*** End Patch",
    ].join("\n")

    const patches = parseOpenAiPatch(text)
    expect(patches.length).toBe(1)
    expect(patches[0]!.type).toBe("add")
    /* SAFETY: patches[0].type was verified to be "add". */
    const patch = patches[0] as Extract<(typeof patches)[number], { readonly type: "add" }>
    expect(patch.content).toBe("const a = 1\n\nconst b = 2")
  })
})
