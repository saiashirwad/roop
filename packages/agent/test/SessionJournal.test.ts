import { NodeFileSystem } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { Effect, Exit, FileSystem, Layer, Option, Schema } from "effect"

import { cryptoWeb } from "../src/cryptoWeb.ts"
import { SESSION_FORMAT_VERSION, type SessionEvent } from "../src/SessionEvent.ts"
import {
  Session,
  SessionConflict,
  SessionJournal,
  SessionJournalFs,
  SessionJournalMemory,
  SessionStore,
  SessionStoreFs,
  SessionStoreMemory,
} from "../src/SessionJournal.ts"

const sampleEvents: ReadonlyArray<SessionEvent> = [
  { _tag: "system/message", content: "system instructions" },
  { _tag: "user/message", content: "hello" },
  { _tag: "assistant/message", parts: [{ type: "text", text: "world" }] },
]

const runJournalSuite = (name: string, makeLayer: () => Layer.Layer<SessionJournal>) => {
  it.layer(makeLayer())(`SessionJournal conformance: ${name}`, (it) => {
    it.effect("monotonic revision on append and appendBatch", () =>
      Effect.gen(function* () {
        const journal = yield* SessionJournal
        const sid = "rev-test"

        // Initial append creates session at revision 1
        yield* journal.append(sid, sampleEvents[0]!)
        let session = yield* journal.load(sid)
        assert.strictEqual(session.revision, 1)
        assert.strictEqual(session.events.length, 1)

        // Single append increments revision to 2
        yield* journal.append(sid, sampleEvents[1]!)
        session = yield* journal.load(sid)
        assert.strictEqual(session.revision, 2)
        assert.strictEqual(session.events.length, 2)

        // Batch append of 2 events increments revision to 4
        const newRev = yield* journal.appendBatch(sid, [sampleEvents[2]!, sampleEvents[1]!])
        assert.strictEqual(newRev, 4)
        session = yield* journal.load(sid)
        assert.strictEqual(session.revision, 4)
        assert.strictEqual(session.events.length, 4)
      }),
    )

    it.effect("optimistic concurrency with expectedRevision", () =>
      Effect.gen(function* () {
        const journal = yield* SessionJournal
        const sid = "conflict-test"

        // Initial batch append expecting revision 0
        const rev1 = yield* journal.appendBatch(sid, [sampleEvents[0]!], { expectedRevision: 0 })
        assert.strictEqual(rev1, 1)

        // Appending with correct expected revision succeeds
        const rev2 = yield* journal.appendBatch(sid, [sampleEvents[1]!], { expectedRevision: 1 })
        assert.strictEqual(rev2, 2)

        // Appending with stale expected revision fails with SessionConflict
        const exit = yield* Effect.exit(
          journal.appendBatch(sid, [sampleEvents[2]!], { expectedRevision: 1 }),
        )
        assert.ok(Exit.isFailure(exit))
        /* SAFETY: The test explicitly triggers a conflict failure on stale expected revision. */
        const error = Option.getOrThrow(Exit.findErrorOption(exit)) as SessionConflict
        assert.strictEqual(error._tag, "SessionConflict")
        assert.strictEqual(error.sessionId, sid)
        assert.strictEqual(error.expectedRevision, 1)
        assert.strictEqual(error.actualRevision, 2)

        // append() also checks expectedRevision
        const appendConflict = yield* Effect.exit(
          journal.append(sid, sampleEvents[2]!, { expectedRevision: 1 }),
        )
        assert.ok(Exit.isFailure(appendConflict))
        /* SAFETY: The test explicitly triggers a conflict failure on stale expected revision. */
        const appendError = Option.getOrThrow(
          Exit.findErrorOption(appendConflict),
        ) as SessionConflict
        assert.strictEqual(appendError._tag, "SessionConflict")
        assert.strictEqual(appendError.actualRevision, 2)
      }),
    )

    it.effect("fork preserves events and revision sequence", () =>
      Effect.gen(function* () {
        const journal = yield* SessionJournal
        const source = "fork-source-conf"
        const target = "fork-target-conf"

        yield* journal.appendBatch(source, sampleEvents)
        const forkedMeta = yield* journal.fork(source, target)
        assert.strictEqual(forkedMeta.id, target)
        assert.strictEqual(forkedMeta.revision, 3)

        const forkedSession = yield* journal.load(target)
        assert.strictEqual(forkedSession.revision, 3)
        assert.strictEqual(forkedSession.events.length, 3)
      }),
    )
  })
}

// Conformance tests for in-memory journal
runJournalSuite("Memory", () => SessionJournalMemory)

// Conformance tests for filesystem journal
const tempFsDir = await Effect.runPromise(
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.makeTempDirectory({ prefix: "journal-fs-" }),
  ).pipe(Effect.orDie, Effect.provide(NodeFileSystem.layer)),
)

runJournalSuite("FileSystem", () =>
  SessionJournalFs(tempFsDir).pipe(
    Layer.provideMerge(NodeFileSystem.layer),
    Layer.provide(cryptoWeb),
  ),
)

it("SessionStore aliases match SessionJournal", () => {
  assert.strictEqual(SessionStore, SessionJournal)
  assert.strictEqual(SessionStoreMemory, SessionJournalMemory)
  assert.strictEqual(SessionStoreFs, SessionJournalFs)
})

it.effect("decodes legacy session logs without explicit revision property", () =>
  Effect.gen(function* () {
    const raw = `{"id":"legacy-session","header":{"version":${SESSION_FORMAT_VERSION},"createdAt":1000},"events":[{"_tag":"user/message","content":"hi"},{"_tag":"assistant/message","parts":[{"type":"text","text":"hello"}]}],"updatedAt":1000}`

    const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(Session))(raw)
    assert.strictEqual(decoded.id, "legacy-session")
    assert.strictEqual(decoded.events.length, 2)
    assert.strictEqual(decoded.revision ?? decoded.events.length, 2)
  }),
)
