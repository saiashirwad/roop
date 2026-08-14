import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { assert, it } from "@effect/vitest"

const srcDir = join(fileURLToPath(new URL(".", import.meta.url)), "../src")

const walk = (dir: string): Array<string> =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })

const allowed = (specifier: string) =>
  specifier === "effect" || specifier.startsWith("effect/unstable/ai") || specifier.startsWith(".")

it("portability: agent core imports only effect and effect/unstable/ai", () => {
  const files = walk(srcDir).filter((file) => file.endsWith(".ts"))
  assert.strictEqual(files.length > 0, true)
  for (const file of files) {
    const source = readFileSync(file, "utf8")
    for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
      const specifier = match[1] ?? ""
      assert.strictEqual(allowed(specifier), true, `${file} imports "${specifier}"`)
    }
  }
})
