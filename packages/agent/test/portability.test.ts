import { NodeFileSystem } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { Effect, FileSystem, Path } from "effect"

const allowed = (specifier: string) =>
  specifier === "effect" ||
  specifier === "effect/unstable/ai" ||
  specifier.startsWith("effect/unstable/ai/") ||
  specifier.startsWith(".")

it("portability policy rejects Node and provider imports", () => {
  assert.strictEqual(allowed("node:fs"), false)
  assert.strictEqual(allowed("@effect/ai-openai"), false)
})

it.effect("portability: agent core imports only effect and effect/unstable/ai", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const srcDir = yield* path.fromFileUrl(new URL("../src", import.meta.url))
    const files = (yield* fs.readDirectory(srcDir, { recursive: true }))
      .filter((file) => file.endsWith(".ts"))
      .map((file) => path.join(srcDir, file))
    assert.strictEqual(files.length > 0, true)

    for (const file of files) {
      const source = yield* fs.readFileString(file)
      for (const match of source.matchAll(
        /from\s*["']([^"']+)["']|import\s*\(["']([^"']+)["']\)|import\s*["']([^"']+)["']/g,
      )) {
        const specifier = match[1] ?? match[2] ?? match[3] ?? ""
        assert.strictEqual(allowed(specifier), true, `${file} imports "${specifier}"`)
      }
      for (const banned of ["node:", "process", "Buffer", "require("]) {
        assert.strictEqual(source.includes(banned), false, `${file} references "${banned}"`)
      }
    }
  }).pipe(Effect.provide([NodeFileSystem.layer, Path.layer])),
)
