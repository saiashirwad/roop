import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const oxlint = resolve(root, "node_modules/.bin/oxlint")
const config = resolve(root, ".oxlintrc.json")
const fixtureDirectory = mkdtempSync(join(tmpdir(), "roop-anti-slop-"))

const diagnosticsFor = (name, source) => {
  const path = join(fixtureDirectory, name)
  writeFileSync(path, source)
  const result = spawnSync(oxlint, ["--config", config, "--format", "json", path], {
    cwd: root,
    encoding: "utf8",
  })
  assert.equal(result.error, undefined, result.error?.message)
  const output = JSON.parse(result.stdout)
  assert.equal(
    output.diagnostics.some((diagnostic) => diagnostic.message.includes("Error running JS plugin")),
    false,
    `${name}: plugin crashed\n${result.stdout}`,
  )
  return output.diagnostics
}

const codes = (diagnostics, rule) =>
  diagnostics.filter((diagnostic) => diagnostic.code === `anti-slop(${rule})`)

try {
  const runtime = diagnosticsFor(
    "runtime.ts",
    `type Top = unknown
function scoped() {
  type Local = unknown
  let value: Local
  if (typeof value === "string") {}
}
function typed(value: string | number) {
  if (typeof value === "string") {}
}
type Shadowed = unknown
function shadowed() {
  type Shadowed = string
  let value: Shadowed
  if (typeof value === "string") {}
}
`,
  )
  assert.equal(codes(runtime, "no-runtime-typeof").length, 1)

  const widening = diagnosticsFor(
    "widening.ts",
    `const finite: Record<"a" | "b", unknown> = { a: 1, b: 2 }
/* SAFETY: finite */
const finiteNarrow = finite as { a: number; b: number }
const finiteMapped: { [K in "a" | "b"]: unknown } = { a: 1, b: 2 }
/* SAFETY: finite mapped */
const finiteMappedNarrow = finiteMapped as { a: number; b: number }
const mapped: { [K in keyof any]: unknown } = { a: 1 }
/* SAFETY: mapped */
const mappedNarrow = mapped as { a: number }
const picked: Pick<Record<string, unknown>, keyof any> = { a: 1 }
/* SAFETY: picked */
const pickedNarrow = picked as { a: number }
`,
  )
  const wideningLines = codes(widening, "no-widen-then-assert").map(
    (diagnostic) => diagnostic.labels[0].span.line,
  )
  assert.deepEqual(wideningLines, [9, 12])

  const interfaceInheritance = diagnosticsFor(
    "interfaces.ts",
    `interface Base<T> { [key: string]: T }
interface Child extends Base<unknown> {}
type ChildUse = Child
interface ChildAny extends Base<any> {}
type ChildAnyUse = ChildAny
interface ChildSafe extends Base<string> {}
type ChildSafeUse = ChildSafe
`,
  )
  assert.equal(codes(interfaceInheritance, "no-unsafe-dictionary-type").length, 2)

  const interfaceScope = diagnosticsFor(
    "interface-scope.ts",
    `function scoped() {
  interface Local { [key: string]: string }
}
type Unresolved = Local
`,
  )
  assert.equal(codes(interfaceScope, "no-unsafe-dictionary-type").length, 0)

  const safety = diagnosticsFor(
    "safety.ts",
    `declare const value: unknown
/* SAFETY: containing declaration */
const accepted = (): string => value as string
const rejected = (): string => value as string
/* SAFETY: enclosing function comment must not leak into its body */
function outer() {
  const nested = (): string => value as string
}
`,
  )
  const safetyLines = codes(safety, "require-safety-comment-for-type-assertion").map(
    (diagnostic) => diagnostic.labels[0].span.line,
  )
  assert.deepEqual(safetyLines, [4, 7])

  diagnosticsFor(
    "interface-cycle.ts",
    "interface A extends B {}\ninterface B extends A {}\ntype Use = A\n",
  )
  diagnosticsFor(
    "promise-cycle.ts",
    "type Promise = Promise\nfunction f(): Promise<unknown> { throw new Error() }\n",
  )
} finally {
  rmSync(fixtureDirectory, { recursive: true, force: true })
}

console.log("anti-slop focused fixtures passed")
