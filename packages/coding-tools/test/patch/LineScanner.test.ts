import { describe, expect, it } from "@effect/vitest"

import { LineScanner } from "../../src/patch/LineScanner.ts"

describe("LineScanner", () => {
  it("iterates through lines sequentially", () => {
    const scanner = new LineScanner(["alpha", "beta", "gamma"])
    expect(scanner.hasNext).toBeTruthy()
    expect(scanner.position).toBe(0)
    expect(scanner.peek()).toBe("alpha")
    expect(scanner.peekAt(1)).toBe("beta")

    expect(scanner.next()).toBe("alpha")
    expect(scanner.position).toBe(1)
    expect(scanner.peek()).toBe("beta")

    expect(scanner.next()).toBe("beta")
    expect(scanner.next()).toBe("gamma")
    expect(scanner.hasNext).toBeFalsy()
    expect(scanner.peek()).toBeUndefined()
    expect(scanner.next()).toBeUndefined()
  })

  it("skips empty lines", () => {
    const scanner = new LineScanner(["", "   ", "content", "", "end"])
    scanner.skipEmpty()
    expect(scanner.peek()).toBe("content")
    expect(scanner.next()).toBe("content")
    scanner.skipEmpty()
    expect(scanner.peek()).toBe("end")
    expect(scanner.next()).toBe("end")
    scanner.skipEmpty()
    expect(scanner.hasNext).toBeFalsy()
  })

  it("consumes if predicate matches", () => {
    const scanner = new LineScanner(["--- a/file", "+++ b/file", "@@"])
    expect(scanner.consumeIf((l) => l.startsWith("diff "))).toBeUndefined()
    expect(scanner.consumeIf((l) => l.startsWith("--- "))).toBe("--- a/file")
    expect(scanner.consumeIf((l) => l.startsWith("+++ "))).toBe("+++ b/file")
    expect(scanner.peek()).toBe("@@")
  })
})
