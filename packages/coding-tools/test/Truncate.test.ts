import { NodePath } from "@effect/platform-node"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"

import { ExecutionWorld } from "../src/ExecutionWorld.ts"
import { Truncate } from "../src/Truncate.ts"

describe("Truncate", () => {
  it.effect("Truncate.memory: leaves small content intact", () =>
    Effect.gen(function* () {
      const truncate = yield* Truncate
      const smallContent = "console.log('hello world')\nconst x = 1\n"

      const result = yield* truncate.truncate(smallContent, {
        maxBytes: 1000,
        maxLines: 50,
      })

      assert.strictEqual(result.truncated, false)
      assert.strictEqual(result.content, smallContent)
      assert.strictEqual(result.totalLines, 3)
      assert.strictEqual(result.spillPath, undefined)
    }).pipe(Effect.provide(Truncate.memory().pipe(Layer.provideMerge(NodePath.layer)))),
  )

  it.effect("Truncate.memory: truncates content exceeding maxLines and spills to memory", () => {
    const memoryStore = new Map<string, string>()
    return Effect.gen(function* () {
      const truncate = yield* Truncate
      const lines = Array.from({ length: 150 }, (_, i) => `line ${i + 1}`).join("\n")

      const result = yield* truncate.truncate(lines, {
        maxLines: 50,
        previewHeadLines: 10,
        previewTailLines: 5,
        key: "test-lines",
      })

      assert.strictEqual(result.truncated, true)
      assert.strictEqual(result.totalLines, 150)
      assert.ok(result.spillPath !== undefined)
      assert.ok(result.spillPath.includes("test-lines"))
      assert.match(result.content, /line 1\nline 2/)
      assert.match(result.content, /line 150/)
      assert.match(result.content, /135 lines omitted/)

      // Verify the full un-truncated content is in memory storage
      const stored = memoryStore.get(result.spillPath!)
      assert.strictEqual(stored, lines)
    }).pipe(
      Effect.provide(
        Truncate.memory({ store: memoryStore }).pipe(Layer.provideMerge(NodePath.layer)),
      ),
    )
  })

  it.effect("Truncate.layer: writes full spilled output to workspace filesystem", () =>
    Effect.gen(function* () {
      const world = yield* ExecutionWorld
      const truncate = yield* Truncate
      const lines = Array.from({ length: 300 }, (_, i) => `log line ${i + 1}`).join("\n")

      const result = yield* truncate.truncate(lines, {
        maxLines: 100,
        previewHeadLines: 20,
        previewTailLines: 10,
        key: "log-dump",
      })

      assert.strictEqual(result.truncated, true)
      assert.ok(result.spillPath !== undefined)
      assert.ok(result.hint !== undefined)
      assert.match(result.hint, /Full output:/)

      // Verify file exists on the ExecutionWorld filesystem
      const absPath = yield* world.resolvePath(result.spillPath!)
      const fileOnDisk = yield* world.filesystem.readFileString(absPath)
      assert.strictEqual(fileOnDisk, lines)
    }).pipe(
      Effect.provide(
        Truncate.layer().pipe(
          Layer.provideMerge(ExecutionWorld.memory({ root: "/test-workspace" })),
          Layer.provideMerge(NodePath.layer),
        ),
      ),
    ),
  )

  it.effect("Truncate.truncateCommand: truncates stdout and stderr independently", () =>
    Effect.gen(function* () {
      const truncate = yield* Truncate
      const stdout = Array.from({ length: 250 }, (_, i) => `stdout ${i}`).join("\n")
      const stderr = "short error message\n"

      const { stdout: outRes, stderr: errRes } = yield* truncate.truncateCommand(
        "npm test",
        stdout,
        stderr,
        { maxLines: 50, previewHeadLines: 10, previewTailLines: 5 },
      )

      assert.strictEqual(outRes.truncated, true)
      assert.ok(outRes.spillPath?.includes("npm-stdout"))

      assert.strictEqual(errRes.truncated, false)
      assert.strictEqual(errRes.content, stderr)
      assert.strictEqual(errRes.spillPath, undefined)
    }).pipe(Effect.provide(Truncate.memory().pipe(Layer.provideMerge(NodePath.layer)))),
  )

  it.effect("bounds a single enormous UTF-8 line while preserving the spill", () => {
    const memoryStore = new Map<string, string>()
    const content = "💥".repeat(4_000)
    return Effect.gen(function* () {
      const truncate = yield* Truncate
      const result = yield* truncate.truncate(content, {
        maxBytes: 200,
        maxLines: 1,
        previewHead: 1,
        previewTail: 0,
      })

      assert.strictEqual(result.truncated, true)
      assert.ok(result.spillPath !== undefined)
      assert.strictEqual(memoryStore.get(result.spillPath), content)
      // The recovery hint is allowed in addition to the bounded projection;
      // ensure the model never receives the original 16 KiB line.
      assert.ok(new TextEncoder().encode(result.content).byteLength < 1_000)
    }).pipe(
      Effect.provide(
        Truncate.memory({ store: memoryStore }).pipe(Layer.provideMerge(NodePath.layer)),
      ),
    )
  })
})
