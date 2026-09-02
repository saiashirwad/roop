import { assert, it } from "@effect/vitest"
import { Duration, Effect, Exit, Option, Schema } from "effect"
import { TestClock } from "effect/testing"

import { SessionId } from "../src/DomainIds.ts"
import { EVENT_VERSION, type JournalEvent } from "../src/Event.ts"
import {
  emptySessionMetadata,
  foldSessionMetadata,
  Journal,
  JournalEmptyAppend,
  JournalError,
  JournalFutureVersion,
  JournalRevisionConflict,
  SessionSummarySchema,
  validateJournalEvent,
} from "../src/Journal.ts"
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

it("foldSessionMetadata keeps the latest value of each field", () => {
  const folded = foldSessionMetadata(emptySessionMetadata, [
    { _tag: "session/meta", version: EVENT_VERSION, title: "first", cwd: "/one" },
    user("noise"),
    { _tag: "session/meta", version: EVENT_VERSION, title: "second" },
  ])
  assert.deepStrictEqual(folded, { title: Option.some("second"), cwd: Option.some("/one") })
})

it.effect("SessionSummarySchema projects absent metadata to omitted keys", () =>
  Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(SessionSummarySchema)({
      sessionId: SessionId.make("s"),
      revision: 1,
      createdAt: 10,
      updatedAt: 20,
      title: Option.some("t"),
      cwd: Option.none(),
    })
    assert.deepStrictEqual(encoded, {
      sessionId: "s",
      revision: 1,
      createdAt: 10,
      updatedAt: 20,
      title: "t",
    })
    const decoded = yield* Schema.decodeEffect(SessionSummarySchema)(encoded)
    assert.deepStrictEqual(decoded.title, Option.some("t"))
    assert.deepStrictEqual(decoded.cwd, Option.none())
  }),
)

it.layer(JournalMemory)("JournalMemory", (it) => {
  it.effect("uses revision-safe atomic appends", () => run)

  it.effect("lists stored sessions with timestamps and metadata, and deletes them", () =>
    Effect.gen(function* () {
      const journal = yield* Journal
      assert.deepStrictEqual(
        (yield* journal.list).filter((session) => session.sessionId.startsWith("listed")),
        [],
      )
      yield* TestClock.adjust(Duration.millis(100))
      yield* journal.append("listed-a", 0, [
        { _tag: "session/meta", version: EVENT_VERSION, title: "A", cwd: "/a" },
        user("one"),
      ])
      yield* TestClock.adjust(Duration.millis(50))
      yield* journal.append("listed-a", 2, [
        { _tag: "session/meta", version: EVENT_VERSION, title: "A2" },
      ])
      yield* journal.append("listed-b", 0, [user("hello")])

      const listed = (yield* journal.list)
        .filter((session) => session.sessionId.startsWith("listed"))
        .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
      assert.deepStrictEqual(listed, [
        {
          sessionId: SessionId.make("listed-a"),
          revision: 3,
          createdAt: 100,
          updatedAt: 150,
          title: Option.some("A2"),
          cwd: Option.some("/a"),
        },
        {
          sessionId: SessionId.make("listed-b"),
          revision: 1,
          createdAt: 150,
          updatedAt: 150,
          title: Option.none(),
          cwd: Option.none(),
        },
      ])

      yield* journal.delete("listed-a")
      yield* journal.delete("listed-missing")
      assert.deepStrictEqual(
        (yield* journal.list)
          .filter((session) => session.sessionId.startsWith("listed"))
          .map((session) => session.sessionId),
        ["listed-b"],
      )
      assert.strictEqual((yield* journal.load("listed-a")).revision, 0)
      assert.strictEqual(yield* journal.append("listed-a", 0, [user("again")]), 1)
    }),
  )

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

  it.effect("validateJournalEvent validates event versions and structures", () =>
    Effect.gen(function* () {
      const valid = yield* validateJournalEvent("session", user("hello"))
      assert.strictEqual(valid._tag, "user/message")
      if (valid._tag === "user/message") {
        assert.strictEqual(valid.content, "hello")
      }

      // SAFETY: Tests the future version rejection branch.
      const futureExit = yield* Effect.exit(
        validateJournalEvent("session", {
          _tag: "user/message",
          version: 2,
          content: "future",
        } as never),
      )
      assert.ok(Exit.isFailure(futureExit))
      assert.ok(
        Schema.is(JournalFutureVersion)(Option.getOrThrow(Exit.findErrorOption(futureExit))),
      )

      // SAFETY: Tests unknown event structure rejection branch.
      const invalidExit = yield* Effect.exit(
        validateJournalEvent("session", { _tag: "unknown", version: 1 } as never),
      )
      assert.ok(Exit.isFailure(invalidExit))
      assert.ok(Schema.is(JournalError)(Option.getOrThrow(Exit.findErrorOption(invalidExit))))
    }),
  )
})
