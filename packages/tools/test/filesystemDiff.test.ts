import { assert, it } from "@effect/vitest"
import { Effect } from "effect"

import { applyHunks, countLines, fileSystemHandlers } from "../src/filesystem.ts"

const makeHandlers = () => {
  const files = new Map<string, string>()
  const fs = {
    exists: (path: string) => Effect.succeed(files.has(path)),
    readFileString: (path: string) =>
      files.has(path)
        ? Effect.succeed(files.get(path)!)
        : Effect.fail({ message: "not found", reason: "NotFound" }),
    writeFileString: (path: string, data: string) =>
      Effect.sync(() => {
        files.set(path, data)
      }),
    makeDirectory: () => Effect.void,
    remove: (path: string) =>
      Effect.sync(() => {
        files.delete(path)
      }),
  }
  const pathService = {
    dirname: (p: string) => {
      const i = p.lastIndexOf("/")
      return i <= 0 ? "." : p.slice(0, i)
    },
  }
  return {
    files,
    handlers: fileSystemHandlers(fs as never, pathService as never),
  }
}

it.effect("writeFile create reports created + bytes", () =>
  Effect.gen(function* () {
    const { handlers, files } = makeHandlers()
    const result = yield* handlers.writeFile({ path: "a.ts", content: "hello\n" })
    assert.strictEqual(result.created, true)
    assert.strictEqual(result.bytesWritten, "hello\n".length)
    assert.strictEqual(files.get("a.ts"), "hello\n")
  }),
)

it.effect("writeFile overwrite reports created false", () =>
  Effect.gen(function* () {
    const { handlers, files } = makeHandlers()
    files.set("a.ts", "old\n")
    const result = yield* handlers.writeFile({ path: "a.ts", content: "new\n" })
    assert.strictEqual(result.created, false)
    assert.strictEqual(files.get("a.ts"), "new\n")
  }),
)

it.effect("editFile returns line stats", () =>
  Effect.gen(function* () {
    const { handlers, files } = makeHandlers()
    files.set("a.ts", "const a = 1\nconst b = 2\n")
    const result = yield* handlers.editFile({
      path: "a.ts",
      oldString: "const a = 1",
      newString: "const a = 42\n// note",
    })
    assert.strictEqual(result.replacements, 1)
    assert.strictEqual(result.linesRemoved, 1)
    assert.strictEqual(result.linesAdded, 2)
    assert.ok(files.get("a.ts")?.includes("42"))
  }),
)

it.effect("applyHunks multi-hunk sequential + strict fail", () =>
  Effect.sync(() => {
    const ok = applyHunks("alpha\nbeta\ngamma\n", [
      { oldText: "alpha", newText: "ALPHA" },
      { oldText: "beta\ngamma", newText: "BETA" },
    ])
    assert.strictEqual(ok.ok, true)
    if (ok.ok) {
      assert.strictEqual(ok.value.content, "ALPHA\nBETA\n")
      assert.strictEqual(ok.value.hunksApplied, 2)
    }

    const missing = applyHunks("only\n", [{ oldText: "nope", newText: "x" }])
    assert.strictEqual(missing.ok, false)
    if (!missing.ok) assert.strictEqual(missing.error.reason, "NotFound")

    const ambig = applyHunks("aa aa", [{ oldText: "aa", newText: "b" }])
    assert.strictEqual(ambig.ok, false)
    if (!ambig.ok) assert.strictEqual(ambig.error.reason, "Ambiguous")
  }),
)

it.effect("applyPatch update applies hunks and reports stats", () =>
  Effect.gen(function* () {
    const { handlers, files } = makeHandlers()
    files.set("a.ts", "const a = 1\nconst b = 2\n")
    const result = yield* handlers.applyPatch({
      path: "a.ts",
      hunks: [
        { oldText: "const a = 1", newText: "const a = 9" },
        { oldText: "const b = 2", newText: "const b = 8" },
      ],
    })
    assert.strictEqual(result.mode, "update")
    assert.strictEqual(result.hunksApplied, 2)
    assert.strictEqual(files.get("a.ts"), "const a = 9\nconst b = 8\n")
  }),
)

it.effect("applyPatch create and delete", () =>
  Effect.gen(function* () {
    const { handlers, files } = makeHandlers()
    const created = yield* handlers.applyPatch({
      path: "new.ts",
      mode: "create",
      content: "hello\n",
    })
    assert.strictEqual(created.mode, "create")
    assert.strictEqual(created.linesAdded, countLines("hello\n"))
    assert.strictEqual(files.get("new.ts"), "hello\n")

    const deleted = yield* handlers.applyPatch({
      path: "new.ts",
      mode: "delete",
    })
    assert.strictEqual(deleted.mode, "delete")
    assert.strictEqual(deleted.linesRemoved, countLines("hello\n"))
    assert.strictEqual(files.has("new.ts"), false)
  }),
)

it.effect("applyPatch create fails when path exists", () =>
  Effect.gen(function* () {
    const { handlers, files } = makeHandlers()
    files.set("x.ts", "old")
    const result = yield* handlers
      .applyPatch({ path: "x.ts", mode: "create", content: "new" })
      .pipe(
        Effect.map(() => "ok" as const),
        Effect.catch(() => Effect.succeed("failed" as const)),
      )
    assert.strictEqual(result, "failed")
    assert.strictEqual(files.get("x.ts"), "old")
  }),
)
