import { assert, it } from "@effect/vitest"
import { Effect, Exit, Option, Schema } from "effect"

import { EVENT_VERSION, type JournalEvent } from "../src/Event.ts"
import { Journal, JournalEmptyAppend, JournalRevisionConflict } from "../src/Journal.ts"
import { JournalMemory } from "../src/JournalMemory.ts"

const user = (content: string): JournalEvent => ({
  _tag: "user/message",
  version: EVENT_VERSION,
  content,
})

const run = Effect.gen(function* () {
  const journal = yield* Journal
  const missing = yield* journal.load("session")
  assert.strictEqual(missing.revision, 0)
  assert.deepStrictEqual(missing.events, [])

  const first = yield* journal.append("session", 0, [user("one")])
  assert.strictEqual(first, 1)
  const second = yield* journal.append("session", 1, [user("two"), user("three")])
  assert.strictEqual(second, 3)

  const stale = yield* Effect.exit(journal.append("session", 1, [user("stale")]))
  assert.ok(Exit.isFailure(stale))
  const conflict = Option.getOrThrow(Exit.findErrorOption(stale))
  assert.ok(Schema.is(JournalRevisionConflict)(conflict))
  assert.deepStrictEqual(
    (yield* journal.load("session")).events.map((event) => event._tag),
    ["user/message", "user/message", "user/message"],
  )

  // SAFETY: This intentionally exercises the runtime empty-batch guard below the tuple type.
  const empty = yield* Effect.exit(journal.append("session", 3, [] as never))
  assert.ok(Exit.isFailure(empty))
  assert.ok(Schema.is(JournalEmptyAppend)(Option.getOrThrow(Exit.findErrorOption(empty))))
  assert.strictEqual((yield* journal.load("session")).revision, 3)
})

it.layer(JournalMemory)("JournalMemory", (it) => {
  it.effect("uses revision-safe atomic appends", () => run)

  it.effect("admits one of two concurrent writers at the same revision", () =>
    Effect.gen(function* () {
      const journal = yield* Journal
      const results = yield* Effect.all(
        [
          Effect.exit(journal.append("concurrent", 0, [user("first")])),
          Effect.exit(journal.append("concurrent", 0, [user("second")])),
        ],
        { concurrency: "unbounded" },
      )
      const successes = results.filter(Exit.isSuccess)
      const failures = results.filter(Exit.isFailure)
      assert.strictEqual(successes.length, 1)
      assert.strictEqual(failures.length, 1)
      if (failures.length === 1) {
        const error = Option.getOrThrow(Exit.findErrorOption(failures[0]!))
        assert.ok(Schema.is(JournalRevisionConflict)(error))
      }
      const snapshot = yield* journal.load("concurrent")
      assert.strictEqual(snapshot.revision, 1)
      assert.strictEqual(snapshot.events.length, 1)
    }),
  )
})
