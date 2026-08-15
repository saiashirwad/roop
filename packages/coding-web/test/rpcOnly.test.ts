import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { expect, it } from "vitest"

const allowed = [
  /^@effect\/atom-react$/,
  /^@roop\/agent\/AgentEvent\.ts$/,
  /^@roop\/agent-rpc\//,
  /^@stylexjs\/stylex$/,
  /^effect$/,
  /^@lexical\/react\/[A-Za-z]+$/,
  /^cmdk$/,
  /^effect\/unstable\/(reactivity|rpc)$/,
  /^lexical$/,
  /^marked$/,
  /^react(-dom(\/client)?)?$/,
  /^\.\//,
]

it("only talks to the agent through the rpc client", () => {
  const dir = join(import.meta.dirname, "../src")
  for (const file of readdirSync(dir).filter((file) => !file.endsWith(".d.ts"))) {
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
