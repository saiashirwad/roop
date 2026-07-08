import { assert, it } from "@effect/vitest"
import { Effect } from "effect"

import { clip, formatToolCall, formatToolResult } from "../src/toolView.ts"

it.effect("formatToolCall shows salient args per tool", () =>
  Effect.sync(() => {
    assert.strictEqual(formatToolCall("readFile", { path: "src/main.ts" }), "src/main.ts")
    assert.strictEqual(
      formatToolCall("listFiles", { path: "src", recursive: true }),
      "src (recursive)",
    )
    assert.strictEqual(formatToolCall("grep", { pattern: "spawn", path: "." }), '"spawn" in .')
    assert.strictEqual(formatToolCall("bash", { command: "pnpm  test\n" }), "pnpm test")
    assert.strictEqual(
      formatToolCall("spawnAgent", { agent: "explore", task: "map core", background: true }),
      "explore (background) “map core”",
    )
    assert.strictEqual(formatToolCall("awaitAgents", { runIds: ["a", "b"] }), "2 runs (all)")
    assert.strictEqual(formatToolCall("mystery", { alpha: "one", beta: 2 }), "alpha=one beta=2")
  }),
)

it.effect("formatToolResult summarizes known result shapes", () =>
  Effect.sync(() => {
    assert.strictEqual(
      formatToolResult("readFile", { path: "a", content: "x\ny\n" }, false),
      "3 lines",
    )
    assert.strictEqual(
      formatToolResult(
        "listFiles",
        { entries: ["a", "b"], totalEntries: 9, truncated: true },
        false,
      ),
      "2 of 9 entries",
    )
    assert.strictEqual(
      formatToolResult("bash", { exitCode: 0, stdout: "hello\nworld" }, false),
      "exit 0 · hello",
    )
    assert.strictEqual(
      formatToolResult(
        "grep",
        { matches: [{ path: "a.ts" }, { path: "a.ts" }, { path: "b.ts" }], totalMatches: 3 },
        false,
      ),
      "3 matches in 2 files",
    )
    assert.strictEqual(
      formatToolResult("spawnAgent", { status: "completed", summary: "found 4 modules" }, false),
      "completed · found 4 modules",
    )
    assert.strictEqual(
      formatToolResult("spawnAgent", { status: "running", childRunId: "6ec3b78a-dbe6" }, false),
      "running · run 6ec3b78a…",
    )
    assert.strictEqual(
      formatToolResult("awaitAgents", { results: [{}, {}], pending: ["x"] }, false),
      "2 settled · 1 pending",
    )
    assert.strictEqual(formatToolResult("stopAgent", { stopped: true }, false), "stopped")
  }),
)

it.effect("formatToolResult surfaces failures and falls back generically", () =>
  Effect.sync(() => {
    assert.strictEqual(
      formatToolResult("readFile", { message: "not found", reason: "NotFound" }, true),
      "NotFound: not found",
    )
    assert.strictEqual(formatToolResult("mystery", { ok: true }, false), '{"ok":true}')
    assert.strictEqual(clip("a".repeat(100), 10), `${"a".repeat(10)}…`)
  }),
)
