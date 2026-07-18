import { assert, it } from "@effect/vitest"
import { Effect, Exit } from "effect"

import { fakeFsHandlers, memoryFileStorage, normalizePath } from "../src/fakefs.ts"

const make = () => fakeFsHandlers(memoryFileStorage())

it.effect("writeFile creates and readFile reads back", () =>
  Effect.gen(function* () {
    const handlers = make()
    const written = yield* handlers.writeFile({ path: "src/main.ts", content: "hello" })
    assert.deepStrictEqual(written, { path: "src/main.ts", bytesWritten: 5, created: true })

    const read = yield* handlers.readFile({ path: "src/main.ts" })
    assert.strictEqual(read.content, "hello")

    const overwritten = yield* handlers.writeFile({ path: "./src/main.ts", content: "bye" })
    assert.strictEqual(overwritten.created, false)
  }),
)

it.effect("readFile fails with NotFound for missing files", () =>
  Effect.gen(function* () {
    const handlers = make()
    const exit = yield* Effect.exit(handlers.readFile({ path: "nope.ts" }))
    assert.isTrue(Exit.isFailure(exit))
  }),
)

it.effect("listFiles lists immediate children and recurses", () =>
  Effect.gen(function* () {
    const handlers = make()
    yield* handlers.writeFile({ path: "a.ts", content: "" })
    yield* handlers.writeFile({ path: "src/b.ts", content: "" })
    yield* handlers.writeFile({ path: "src/deep/c.ts", content: "" })

    const root = yield* handlers.listFiles({ path: ".", recursive: true })
    assert.deepStrictEqual(root.entries, ["a.ts", "src/"])
    assert.strictEqual(root.recursive, false)

    const src = yield* handlers.listFiles({ path: "src", recursive: true })
    assert.deepStrictEqual(src.entries, ["src/b.ts", "src/deep/c.ts"])
  }),
)

it.effect("editFile replaces a unique match and fails on ambiguous", () =>
  Effect.gen(function* () {
    const handlers = make()
    yield* handlers.writeFile({ path: "f.ts", content: "one two two" })

    const edited = yield* handlers.editFile({
      path: "f.ts",
      oldString: "one",
      newString: "1",
    })
    assert.strictEqual(edited.replacements, 1)

    const ambiguous = yield* Effect.exit(
      handlers.editFile({ path: "f.ts", oldString: "two", newString: "2" }),
    )
    assert.isTrue(Exit.isFailure(ambiguous))

    yield* handlers.editFile({ path: "f.ts", oldString: "two", newString: "2", replaceAll: true })
    const read = yield* handlers.readFile({ path: "f.ts" })
    assert.strictEqual(read.content, "1 2 2")
  }),
)

it.effect("applyPatch create/update/delete lifecycle", () =>
  Effect.gen(function* () {
    const handlers = make()
    yield* handlers.applyPatch({ path: "p.ts", mode: "create", content: "alpha\nbeta" })

    const updated = yield* handlers.applyPatch({
      path: "p.ts",
      mode: "update",
      hunks: [{ oldText: "beta", newText: "gamma" }],
    })
    assert.strictEqual(updated.hunksApplied, 1)
    assert.strictEqual((yield* handlers.readFile({ path: "p.ts" })).content, "alpha\ngamma")

    const duplicate = yield* Effect.exit(
      handlers.applyPatch({ path: "p.ts", mode: "create", content: "x" }),
    )
    assert.isTrue(Exit.isFailure(duplicate))

    yield* handlers.applyPatch({ path: "p.ts", mode: "delete" })
    assert.isTrue(Exit.isFailure(yield* Effect.exit(handlers.readFile({ path: "p.ts" }))))
  }),
)

it.effect("paths cannot escape the workspace root", () =>
  Effect.gen(function* () {
    const handlers = make()
    assert.strictEqual(normalizePath("../secret"), undefined)
    assert.strictEqual(normalizePath("a/../../secret"), undefined)
    assert.strictEqual(normalizePath("./a//b.ts"), "a/b.ts")

    assert.isTrue(
      Exit.isFailure(yield* Effect.exit(handlers.writeFile({ path: "../x", content: "" }))),
    )
  }),
)
