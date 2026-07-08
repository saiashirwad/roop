import { assert, it } from "@effect/vitest"
import { Effect } from "effect"

import {
  initialMarkdownLineState,
  makeMarkdownWriter,
  styleInline,
  styleMarkdownLine,
} from "../src/markdown.ts"

const BOLD = "\x1b[1m"
const CYAN = "\x1b[36m"
const GRAY = "\x1b[90m"
const RESET = "\x1b[0m"

it.effect("styleInline styles code spans and bold", () =>
  Effect.sync(() => {
    assert.strictEqual(styleInline("use `pnpm dev` now"), `use ${CYAN}pnpm dev${RESET} now`)
    assert.strictEqual(styleInline("**very** plain"), `${BOLD}very${RESET} plain`)
    assert.strictEqual(styleInline("no markup"), "no markup")
  }),
)

it.effect("styleMarkdownLine handles headers, bullets, quotes, fences", () =>
  Effect.sync(() => {
    const header = styleMarkdownLine("## Setup", initialMarkdownLineState)
    assert.strictEqual(header.text, `${BOLD}## Setup${RESET}`)

    const bullet = styleMarkdownLine("- run `check`", initialMarkdownLineState)
    assert.strictEqual(bullet.text, `• run ${CYAN}check${RESET}`)

    const quote = styleMarkdownLine("> aside", initialMarkdownLineState)
    assert.strictEqual(quote.text, `${GRAY}> aside${RESET}`)

    const open = styleMarkdownLine("```ts", initialMarkdownLineState)
    assert.strictEqual(open.state.inCodeFence, true)
    const inside = styleMarkdownLine("# not a header", open.state)
    assert.strictEqual(inside.text, "# not a header")
    const close = styleMarkdownLine("```", inside.state)
    assert.strictEqual(close.state.inCodeFence, false)
  }),
)

it.effect("writer styles lines split across deltas and flushes remainder", () =>
  Effect.sync(() => {
    const writer = makeMarkdownWriter()
    let out = writer.write("## Ti")
    assert.strictEqual(out, "")
    out += writer.write("tle\n- ite")
    assert.ok(out.includes(`${BOLD}## Title${RESET}\n`))
    out += writer.write("m one\ntail")
    assert.ok(out.includes("• item one\n"))
    assert.strictEqual(writer.flush(), "tail")
    assert.strictEqual(writer.flush(), "")
  }),
)

it.effect("writer streams oversized partial lines raw without restyling", () =>
  Effect.sync(() => {
    const writer = makeMarkdownWriter()
    const long = "x".repeat(250)
    const flushed = writer.write(long)
    assert.strictEqual(flushed, long)
    assert.strictEqual(writer.write("**tail**\n"), "**tail**\n")
    assert.strictEqual(writer.write("**ok**\n"), `${BOLD}ok${RESET}\n`)
  }),
)
