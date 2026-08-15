import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { expect, it } from "vitest"

const allowed = [
  /^@mariozechner\/pi-tui$/,
  /^@roop\/agent\/AgentEvent\.ts$/,
  /^@roop\/agent-rpc\//,
  /^effect$/,
  /^effect\/unstable\/rpc$/,
  /^\.\//,
]

it("only talks to the agent through the rpc client", () => {
  const dir = join(import.meta.dirname, "../src")
  for (const file of readdirSync(dir)) {
    const source = readFileSync(join(dir, file), "utf8")
    for (const match of source.matchAll(/from "([^"]+)"/g)) {
      const specifier = match[1]!
      expect(
        allowed.some((pattern) => pattern.test(specifier)),
        `${file} imports ${specifier}`,
      ).toBe(true)
    }
  }
})
