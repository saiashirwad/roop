import { expect, it } from "vitest"

declare global {
  interface ImportMeta {
    readonly glob: (
      pattern: string,
      options: {
        readonly query: "?raw"
        readonly eager: true
        readonly import: "default"
      },
    ) => { readonly [path: string]: string }
  }
}

const allowed = [
  /^@mariozechner\/pi-tui$/,
  /^@roop\/agent\/AgentEvents\.ts$/,
  /^@roop\/agent\/cryptoWeb\.ts$/,
  /^@roop\/agent-rpc\//,
  /^effect$/,
  /^effect\/unstable\/rpc$/,
  /^\.\//,
]

const sources = import.meta.glob("../src/**/*.ts", {
  query: "?raw",
  eager: true,
  import: "default",
})

it("only talks to the agent through the rpc client", () => {
  for (const [, source] of Object.entries(sources)) {
    for (const match of source.matchAll(/\b(?:from\s*|import\s*(?:\(\s*)?)(["'])([^"']+)\1/g)) {
      const specifier = match[2]!
      expect(allowed.some((pattern) => pattern.test(specifier))).toBeTruthy()
    }
  }
})
