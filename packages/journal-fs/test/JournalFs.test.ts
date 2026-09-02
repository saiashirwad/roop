import { tmpdir } from "node:os"

import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { DomainIds, Event, Journal as JournalModule } from "@roop/agent"
import { Duration, Effect, Exit, FileSystem, Layer, Option, Path, Schema } from "effect"
import { TestClock } from "effect/testing"

import { JournalFs } from "../src/index.ts"

const { SessionId } = DomainIds
const { EVENT_VERSION } = Event
const { Journal, JournalError, JournalRevisionConflict } = JournalModule
type JournalEvent = Event.JournalEvent

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

const user = (content: string): JournalEvent => ({
  _tag: "user/message",
  version: EVENT_VERSION,
  content,
})
const meta = (title: string, cwd?: string): JournalEvent =>
  cwd === undefined
    ? { _tag: "session/meta", version: EVENT_VERSION, title }
    : { _tag: "session/meta", version: EVENT_VERSION, title, cwd }

/** A fresh temp directory, removed when the test scope closes. */
const tempDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const directory = yield* fs.makeTempDirectoryScoped({
    directory: tmpdir(),
    prefix: "roop-journal-fs-",
  })
  return directory
})

const journalIn = (directory: string) =>
  JournalFs.layer({ directory }).pipe(Layer.provide(platform))

/** Run `program` against a fresh layer instance over `directory` (a simulated restart). */
const withJournal = <A, E>(
  directory: string,
  program: Effect.Effect<A, E, JournalModule.Journal>,
) => program.pipe(Effect.provide(journalIn(directory)))

it.effect("appends with revision checks, loads validated events, lists and deletes", () =>
  Effect.gen(function* () {
    const directory = yield* tempDirectory
    yield* withJournal(
      directory,
      Effect.gen(function* () {
        const journal = yield* Journal
        assert.deepStrictEqual(yield* journal.list, [])
        assert.strictEqual((yield* journal.load("missing")).revision, 0)

        yield* TestClock.adjust(Duration.millis(1_000))
        assert.strictEqual(yield* journal.append("s1", 0, [meta("First", "/w"), user("one")]), 2)
        yield* TestClock.adjust(Duration.millis(500))
        assert.strictEqual(yield* journal.append("s1", 2, [user("two"), meta("Renamed")]), 4)

        const stale = yield* Effect.exit(journal.append("s1", 2, [user("stale")]))
        assert.ok(Exit.isFailure(stale))
        assert.ok(
          Schema.is(JournalRevisionConflict)(Option.getOrThrow(Exit.findErrorOption(stale))),
        )

        const snapshot = yield* journal.load("s1")
        assert.strictEqual(snapshot.revision, 4)
        assert.deepStrictEqual(snapshot.events, [
          meta("First", "/w"),
          user("one"),
          user("two"),
          meta("Renamed"),
        ])

        assert.deepStrictEqual(yield* journal.list, [
          {
            sessionId: SessionId.make("s1"),
            revision: 4,
            createdAt: 1_000,
            updatedAt: 1_500,
            title: Option.some("Renamed"),
            cwd: Option.some("/w"),
          },
        ])

        yield* journal.delete("s1")
        yield* journal.delete("s1")
        assert.deepStrictEqual(yield* journal.list, [])
        assert.strictEqual((yield* journal.load("s1")).revision, 0)
      }),
    )
  }).pipe(Effect.provide(platform)),
)

it.effect("survives a restart: a fresh layer over the same directory sees the same data", () =>
  Effect.gen(function* () {
    const directory = yield* tempDirectory
    const childId = "parent:1/agents/researcher/call:2"
    yield* withJournal(
      directory,
      Effect.gen(function* () {
        const journal = yield* Journal
        yield* journal.append("parent:1", 0, [meta("Parent"), user("hello")])
        yield* journal.append(childId, 0, [user("child")])
      }),
    )
    yield* withJournal(
      directory,
      Effect.gen(function* () {
        const journal = yield* Journal
        const parent = yield* journal.load("parent:1")
        assert.deepStrictEqual(parent.events, [meta("Parent"), user("hello")])
        const child = yield* journal.load(childId)
        assert.strictEqual(child.revision, 1)
        assert.deepStrictEqual(
          (yield* journal.list)
            .map((session) => [String(session.sessionId), session.title] as const)
            .sort((left, right) => left[0].localeCompare(right[0])),
          [
            ["parent:1", Option.some("Parent")],
            [childId, Option.none()],
          ],
        )
        // The revision on disk is authoritative for the new instance.
        assert.strictEqual(yield* journal.append("parent:1", 2, [user("more")]), 3)
      }),
    )
  }).pipe(Effect.provide(platform)),
)

it.effect("admits one of two concurrent writers at the same revision", () =>
  Effect.gen(function* () {
    const directory = yield* tempDirectory
    yield* withJournal(
      directory,
      Effect.gen(function* () {
        const journal = yield* Journal
        const results = yield* Effect.all(
          [
            Effect.exit(journal.append("race", 0, [user("first")])),
            Effect.exit(journal.append("race", 0, [user("second")])),
          ],
          { concurrency: "unbounded" },
        )
        assert.strictEqual(results.filter(Exit.isSuccess).length, 1)
        assert.strictEqual(results.filter(Exit.isFailure).length, 1)
        assert.strictEqual((yield* journal.load("race")).revision, 1)
      }),
    )
  }).pipe(Effect.provide(platform)),
)

it.effect("tolerates a torn final line and repairs it on the next append", () =>
  Effect.gen(function* () {
    const directory = yield* tempDirectory
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const log = path.join(directory, "torn.jsonl")
    yield* withJournal(
      directory,
      Effect.flatMap(Journal, (journal) => journal.append("torn", 0, [user("ok")])),
    )
    yield* fs.writeFileString(log, '{"_tag":"user/mess', { flag: "a" })
    yield* withJournal(
      directory,
      Effect.gen(function* () {
        const journal = yield* Journal
        const before = yield* journal.load("torn")
        assert.strictEqual(before.revision, 1)
        assert.strictEqual(yield* journal.append("torn", 1, [user("after")]), 2)
        assert.deepStrictEqual(
          (yield* journal.load("torn")).events.map((event) =>
            event._tag === "user/message" ? event.content : event._tag,
          ),
          ["ok", "after"],
        )
      }),
    )
    const content = yield* fs.readFileString(log)
    assert.strictEqual(content.split("\n").length, 3)
  }).pipe(Effect.provide(platform)),
)

it.effect("rebuilds a missing index entry from the log and rejects corrupt lines", () =>
  Effect.gen(function* () {
    const directory = yield* tempDirectory
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* withJournal(
      directory,
      Effect.flatMap(Journal, (journal) =>
        journal.append("indexed", 0, [meta("Indexed"), user("one")]),
      ),
    )
    yield* fs.remove(path.join(directory, "indexed.meta.json"))
    yield* withJournal(
      directory,
      Effect.gen(function* () {
        const journal = yield* Journal
        const listed = yield* journal.list
        assert.strictEqual(listed.length, 1)
        assert.strictEqual(listed[0]?.revision, 2)
        assert.deepStrictEqual(listed[0]?.title, Option.some("Indexed"))
        assert.ok(yield* fs.exists(path.join(directory, "indexed.meta.json")))
      }),
    )

    yield* fs.writeFileString(
      path.join(directory, "corrupt.jsonl"),
      '{"_tag":"user/message","version":1,"content":"fine"}\n{"_tag":"nope","version":1}\n',
    )
    const exit = yield* withJournal(
      directory,
      Effect.flatMap(Journal, (journal) => Effect.exit(journal.load("corrupt"))),
    )
    assert.ok(Exit.isFailure(exit))
    const error = Option.getOrThrow(Exit.findErrorOption(exit))
    assert.ok(Schema.is(JournalError)(error))
    assert.strictEqual(error.operation, "decode")
    assert.ok(error.message.includes("line 2"))
  }).pipe(Effect.provide(platform)),
)
