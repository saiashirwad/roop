import { expect, it } from "vitest"

const allowed = [
  /^@effect\/atom-react$/,
  /^@roop\/agent\/AgentEvent\.ts$/,
  /^@roop\/agent\/SessionEvent\.ts$/,
  /^@roop\/agent\/cryptoWeb\.ts$/,
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

const sources = import.meta.glob("../src/**/*.{ts,tsx}", {
  query: "?raw",
  eager: true,
  import: "default",
})

it("only talks to the agent through the rpc client", () => {
  for (const [path, source] of Object.entries(sources)) {
    const file = path.slice(Math.max(0, path.lastIndexOf("/") + 1))
    if (file.endsWith(".d.ts")) continue
    // Cover static imports, side-effect imports, dynamic imports, and exports.
    // This intentionally stays lexical: source files are trusted inputs and
    // the test's job is to catch a newly introduced dependency edge.
    for (const match of source.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)(["'])([^"']+)\1/g)) {
      const specifier = match[2]!
      expect(
        allowed.some((pattern) => pattern.test(specifier)),
        `${file} imports ${specifier}`,
      ).toBe(true)
    }
  }
})
