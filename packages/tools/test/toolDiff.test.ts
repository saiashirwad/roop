import { assert, it } from "@effect/vitest"
import { Effect } from "effect"

import { countLines } from "../src/filesystem.ts"

it.effect("countLines handles empty and multiline", () =>
  Effect.sync(() => {
    assert.strictEqual(countLines(""), 0)
    assert.strictEqual(countLines("a"), 1)
    assert.strictEqual(countLines("a\nb"), 2)
    assert.strictEqual(countLines("a\nb\n"), 3)
  }),
)
