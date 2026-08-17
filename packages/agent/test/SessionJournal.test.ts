import { NodeFileSystem } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { Effect, Exit, FileSystem, Layer, Option, Schema } from "effect"
import type { Prompt } from "effect/unstable/ai"

import { cryptoWeb } from "../src/cryptoWeb.ts"
import { deriveMessages, SESSION_FORMAT_VERSION, type SessionEvent } from "../src/SessionEvent.ts"
import { SessionId } from "../src/SessionId.ts"
import {
  Session,
  SessionConflict,
  SessionJournal,
  SessionJournalFs,
  SessionJournalMemory,
} from "../src/SessionJournal.ts"

const scripted: ReadonlyArray<SessionEvent> = [
  { _tag: "system/message", content: "you are a test" },
  { _tag: "user/message", content: "first question" },
  { _tag: "turn/start" },
  { _tag: "step/start", index: 1 },
  { _tag: "model/request", request: { prompt: { content: [] }, toolChoice: "auto" } },
  { _tag: "tool/call", id: "c1", name: "echo", params: { note: "hi" } },
  { _tag: "tool/call", id: "c2", name: "echo", params: { note: "again" } },
  { _tag: "tool/result", id: "c1", name: "echo", isFailure: false, result: { reply: "hi" } },
  { _tag: "tool/result", id: "c2", name: "echo", isFailure: false, result: { reply: "again" } },
  { _tag: "step/end", reason: "completed" },
  { _tag: "turn/end", reason: "completed" },
  { _tag: "turn/start" },
  { _tag: "step/start", index: 1 },
  { _tag: "model/request", request: { prompt: { content: [] } } },
  { _tag: "assistant/message", parts: [{ type: "text", text: "all done" }] },
  { _tag: "step/end", reason: "completed" },
  { _tag: "turn/end", reason: "completed" },
]

const appendAll = (sessionId: string) =>
  Effect.forEach(
    scripted,
    (event) => Effect.flatMap(SessionJournal, (journal) => journal.append(sessionId, event)),
    { discard: true },
  )

const textOf = (part: Prompt.Part | undefined): string =>
  part !== undefined && (part.type === "text" || part.type === "reasoning") ? part.text : ""

it("deriveMessages projects the log the model would consume", () => {
  const messages = deriveMessages(scripted)

  assert.deepStrictEqual(
    messages.map((message) => message.role),
    ["system", "user", "assistant", "tool", "assistant"],
  )

  /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
  const [system, userMessage, toolCalls, toolResults, final] = messages as [
    Prompt.SystemMessage,
    Prompt.UserMessage,
    Prompt.AssistantMessage,
    Prompt.ToolMessage,
    Prompt.AssistantMessage,
  ]
  assert.strictEqual(system.content, "you are a test")
  assert.strictEqual(textOf(userMessage.content[0]), "first question")

  // consecutive tool calls coalesce into one assistant message
  assert.deepStrictEqual(
    toolCalls.content.map((part) => part.type),
    ["tool-call", "tool-call"],
  )
  assert.deepStrictEqual(
    toolResults.content.map((part) => part.type),
    ["tool-result", "tool-result"],
  )
  assert.strictEqual(textOf(final.content[0]), "all done")
})

it("deriveMessages drops trailing tool calls without results (interrupted turn)", () => {
  const messages = deriveMessages([
    { _tag: "user/message", content: "q" },
    { _tag: "turn/start" },
    { _tag: "tool/call", id: "c1", name: "echo", params: {} },
    { _tag: "turn/end", reason: "interrupted" },
  ])
  assert.deepStrictEqual(
    messages.map((message) => message.role),
    ["user"],
  )
})

it("a log prefix projects to the same history as the full log up to that point (fork)", () => {
  const prefixEnd = scripted.findIndex((event) => event._tag === "turn/end")
  const prefix = deriveMessages(scripted.slice(0, prefixEnd + 1))
  const full = deriveMessages(scripted)
  assert.deepStrictEqual(prefix, full.slice(0, prefix.length))
})

const runJournalConformance = (name: string, makeLayer: () => Layer.Layer<SessionJournal>) => {
  it.layer(makeLayer())(`SessionJournal conformance: ${name}`, (it) => {
    it.effect("monotonic revision on append and appendBatch", () =>
      Effect.gen(function* () {
        const journal = yield* SessionJournal
        const sid = "rev-test"

        // Initial append creates session at revision 1
        yield* journal.append(sid, scripted[0]!)
        let session = yield* journal.load(sid)
        assert.strictEqual(session.revision, 1)
        assert.strictEqual(session.events.length, 1)

        // Single append increments revision to 2
        yield* journal.append(sid, scripted[1]!)
        session = yield* journal.load(sid)
        assert.strictEqual(session.revision, 2)
        assert.strictEqual(session.events.length, 2)

        // Batch append of 2 events increments revision to 4
        const newRev = yield* journal.appendBatch(sid, [scripted[2]!, scripted[3]!])
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
        const rev1 = yield* journal.appendBatch(sid, [scripted[0]!], { expectedRevision: 0 })
        assert.strictEqual(rev1, 1)

        // Appending with correct expected revision succeeds
        const rev2 = yield* journal.appendBatch(sid, [scripted[1]!], { expectedRevision: 1 })
        assert.strictEqual(rev2, 2)

        // Appending with stale expected revision fails with SessionConflict
        const exit = yield* Effect.exit(
          journal.appendBatch(sid, [scripted[2]!], { expectedRevision: 1 }),
        )
        assert.ok(Exit.isFailure(exit))
        const error = Option.getOrThrow(Exit.findErrorOption(exit))
        assert.ok(Schema.is(SessionConflict)(error))
        /* SAFETY: Schema.is above confirms error is a SessionConflict instance. */
        const conflict = error as SessionConflict
        assert.strictEqual(conflict._tag, "SessionConflict")
        assert.strictEqual(conflict.sessionId, sid)
        assert.strictEqual(conflict.expectedRevision, 1)
        assert.strictEqual(conflict.actualRevision, 2)

        // append() also checks expectedRevision
        const appendConflict = yield* Effect.exit(
          journal.append(sid, scripted[2]!, { expectedRevision: 1 }),
        )
        assert.ok(Exit.isFailure(appendConflict))
        const appendError = Option.getOrThrow(Exit.findErrorOption(appendConflict))
        assert.ok(Schema.is(SessionConflict)(appendError))
        /* SAFETY: Schema.is above confirms error is a SessionConflict instance. */
        const appendConflictError = appendError as SessionConflict
        assert.strictEqual(appendConflictError._tag, "SessionConflict")
        assert.strictEqual(appendConflictError.actualRevision, 2)
      }),
    )

    it.effect("fork copies history and preserves revision sequence", () =>
      Effect.gen(function* () {
        const journal = yield* SessionJournal
        const source = "fork-src"
        const target = "fork-dst"

        yield* journal.appendBatch(source, scripted)
        const forkedMeta = yield* journal.fork(source, target)
        assert.strictEqual(forkedMeta.id, target)
        assert.strictEqual(forkedMeta.revision, scripted.length)

        const forkedSession = yield* journal.load(target)
        assert.strictEqual(forkedSession.revision, scripted.length)
        assert.strictEqual(forkedSession.events.length, scripted.length)

        // Appending to forked doesn't affect source
        yield* journal.append(target, { _tag: "user/message", content: "extra" })
        const sourceAfter = yield* journal.load(source)
        const targetAfter = yield* journal.load(target)
        assert.strictEqual(sourceAfter.revision, scripted.length)
        assert.strictEqual(targetAfter.revision, scripted.length + 1)
      }),
    )

    it.effect("load of a missing session fails with SessionNotFound", () =>
      Effect.gen(function* () {
        const journal = yield* SessionJournal
        const exit = yield* Effect.exit(journal.load("missing"))
        assert.ok(Exit.isFailure(exit))
        /* SAFETY: Explicit missing load returns SessionNotFound. */
        const failure = Option.getOrThrow(Exit.findErrorOption(exit)) as { _tag: string }
        assert.strictEqual(failure._tag, "SessionNotFound")
      }),
    )

    it.effect("deriveMessages projects messages for existing session", () =>
      Effect.gen(function* () {
        const journal = yield* SessionJournal
        yield* appendAll("derive-sess")
        const messages = yield* journal.deriveMessages("derive-sess")
        assert.deepStrictEqual(messages, deriveMessages(scripted))
      }),
    )
  })
}

// Conformance tests for in-memory journal
runJournalConformance("Memory", () => SessionJournalMemory)

// Filesystem journal tests
const conformanceDir = await Effect.runPromise(
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.makeTempDirectory({ prefix: "journal-conformance-" }),
  ).pipe(Effect.orDie, Effect.provide(NodeFileSystem.layer)),
)

runJournalConformance("FileSystem", () =>
  SessionJournalFs(conformanceDir).pipe(
    Layer.provideMerge(NodeFileSystem.layer),
    Layer.provide(cryptoWeb),
  ),
)

const dir = await Effect.runPromise(
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeTempDirectory({ prefix: "sessions-" })).pipe(
    Effect.orDie,
    Effect.provide(NodeFileSystem.layer),
  ),
)

const JournalFsLive = SessionJournalFs(dir).pipe(
  Layer.provideMerge(NodeFileSystem.layer),
  Layer.provide(cryptoWeb),
)

it.layer(JournalFsLive)("SessionJournalFs filesystem specific behaviors", (it) => {
  it.effect("persists events and reloads to the same projection (replay)", () =>
    Effect.gen(function* () {
      yield* appendAll("a")

      const reopened = yield* Effect.provide(
        Effect.gen(function* () {
          const events = (yield* (yield* SessionJournal).load("a")).events
          const messages = yield* (yield* SessionJournal).deriveMessages("a")
          return [events, messages] as const
        }),
        SessionJournalFs(dir).pipe(Layer.provide(NodeFileSystem.layer), Layer.provide(cryptoWeb)),
      )
      const [events, messages] = reopened
      assert.strictEqual(events.length, scripted.length)
      assert.deepStrictEqual(messages, deriveMessages(scripted))

      const metas = yield* (yield* SessionJournal).list
      assert.deepStrictEqual(
        metas.map((meta) => [meta.id, meta.title, meta.revision]),
        [["a", "first question", scripted.length]],
      )
    }),
  )

  it.effect("write leaves no stray tmp files beside the logs", () =>
    Effect.gen(function* () {
      yield* appendAll("tmpcheck")
      const fs = yield* FileSystem.FileSystem
      const entries = yield* fs.readDirectory(dir)
      assert.deepStrictEqual(
        entries.filter((entry) => entry.endsWith(".tmp")),
        [],
      )
    }).pipe(Effect.provide([NodeFileSystem.layer, cryptoWeb])),
  )

  const uid = process.getuid?.()
  const permissionEnforced = uid !== undefined && uid !== 0 && process.platform !== "win32"
  it.effect("append fails with SessionIoError (does not reset) when the log is unreadable", () => {
    const lockedDir = `${dir}/locked`
    const LockedJournal = SessionJournalFs(lockedDir).pipe(
      Layer.provideMerge(NodeFileSystem.layer),
      Layer.provide(cryptoWeb),
    )
    return Effect.provide(
      Effect.gen(function* () {
        if (!permissionEnforced) return
        const fs = yield* FileSystem.FileSystem
        yield* appendAll("locked-session")
        yield* fs.chmod(lockedDir, 0o000)
        const exit = yield* Effect.exit(
          (yield* SessionJournal).append("locked-session", {
            _tag: "user/message",
            content: "should not land",
          }),
        ).pipe(Effect.onExit(() => fs.chmod(lockedDir, 0o700)))
        assert.ok(Exit.isFailure(exit))
        /* SAFETY: Permission revocation causes a typed SessionIoError in the error channel. */
        const error = Option.getOrThrow(Exit.findErrorOption(exit)) as { _tag: string }
        assert.strictEqual(error._tag, "SessionIoError")
      }),
      LockedJournal,
    )
  })

  it.effect("rejects a log with a newer format version", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const json = yield* Schema.encodeEffect(Schema.fromJsonString(Session))({
        id: SessionId.make("future"),
        header: { version: SESSION_FORMAT_VERSION + 1, createdAt: 0 },
        events: [{ _tag: "user/message", content: "hi" }],
        updatedAt: 0,
        revision: 1,
      })
      yield* fs.writeFileString(`${dir}/future.json`, json)

      const journal = yield* SessionJournal
      const exit = yield* Effect.exit(journal.load("future"))
      assert.ok(Exit.isFailure(exit))
      /* SAFETY: Future format versions trigger a SessionFormatError. */
      const failure = Option.getOrThrow(Exit.findErrorOption(exit)) as {
        _tag: string
        message: string
      }
      assert.strictEqual(failure._tag, "SessionFormatError")
      assert.match(failure.message, /version 2/)

      const derived = yield* Effect.exit(journal.deriveMessages("future"))
      assert.ok(Exit.isFailure(derived))
    }),
  )

  it.effect("list skips corrupt sessions and returns the valid ones", () =>
    Effect.gen(function* () {
      yield* appendAll("good")
      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFileString(`${dir}/broken.json`, "{not json")
      yield* fs.writeFileString(`${dir}/%E0%A4%A.json`, "{}")

      const metas = yield* (yield* SessionJournal).list
      assert.deepStrictEqual(metas.map((meta) => meta.id).sort(), ["a", "good", "tmpcheck"])
    }),
  )

  it.effect("rejects a log that fails validation", () =>
    Effect.gen(function* () {
      yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.writeFileString(`${dir}/corrupt.json`, "{not json")),
      )

      const exit = yield* Effect.exit((yield* SessionJournal).load("corrupt"))
      assert.ok(Exit.isFailure(exit))
      /* SAFETY: Corrupted json files fail with SessionFormatError. */
      const failure = Option.getOrThrow(Exit.findErrorOption(exit)) as { _tag: string }
      assert.strictEqual(failure._tag, "SessionFormatError")
    }),
  )

  it.effect("preserves encoded session ids and serializes concurrent appends", () =>
    Effect.gen(function* () {
      const journal = yield* SessionJournal
      const sessionId = "unicode/セッション?"
      const events = Array.from({ length: 12 }, (_, index) => ({
        _tag: "user/message" as const,
        content: `message-${index}`,
      }))
      yield* Effect.all(
        events.map((event) => journal.append(sessionId, event)),
        { concurrency: "unbounded", discard: true },
      )
      const session = yield* journal.load(sessionId)
      assert.strictEqual(session.events.length, events.length)
      assert.strictEqual(session.revision, events.length)
      assert.deepStrictEqual(
        session.events.map((event) => (event._tag === "user/message" ? event.content : "")).sort(),
        events.map((event) => event.content).sort(),
      )
    }),
  )

  it.effect("rejects concurrent forks that target the same session id", () =>
    Effect.gen(function* () {
      const journal = yield* SessionJournal
      yield* appendAll("fork-source")
      const results = yield* Effect.all(
        [0, 1].map(() => Effect.exit(journal.fork("fork-source", "fork-target"))),
        { concurrency: "unbounded" },
      )
      assert.strictEqual(results.filter(Exit.isSuccess).length, 1)
      assert.strictEqual(results.filter(Exit.isFailure).length, 1)
      const failure = results.find(Exit.isFailure)!
      /* SAFETY: Concurrent duplicate target fork fails with SessionAlreadyExists. */
      const error = Option.getOrThrow(Exit.findErrorOption(failure)) as { _tag: string }
      assert.strictEqual(error._tag, "SessionAlreadyExists")
    }),
  )
})
