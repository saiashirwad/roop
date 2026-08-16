import { NodeFileSystem } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { Cause, Effect, Exit, FileSystem, Layer, Option, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"

import { cryptoWeb } from "../src/cryptoWeb.ts"
import { deriveMessages, SESSION_FORMAT_VERSION, type SessionEvent } from "../src/SessionEvent.ts"
import { SessionId } from "../src/SessionId.ts"
import { Session, SessionStore, SessionStoreFs, SessionStoreMemory } from "../src/SessionStore.ts"

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
    (event) => Effect.flatMap(SessionStore, (store) => store.append(sessionId, event)),
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

it.effect("memory store appends and derives", () =>
  Effect.gen(function* () {
    const store = yield* SessionStore
    yield* appendAll("mem")

    const session = yield* store.load("mem")
    assert.strictEqual(session.events.length, scripted.length)
    assert.strictEqual(session.header.version, SESSION_FORMAT_VERSION)

    const messages = yield* store.deriveMessages("mem")
    assert.deepStrictEqual(messages, deriveMessages(scripted))

    const metas = yield* store.list
    assert.deepStrictEqual(
      metas.map((meta) => [meta.id, meta.title]),
      [["mem", "first question"]],
    )

    const missing = yield* Effect.exit(store.deriveMessages("nope"))
    assert.ok(Exit.isFailure(missing))
  }).pipe(Effect.provide(SessionStoreMemory)),
)

const dir = await Effect.runPromise(
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeTempDirectory({ prefix: "sessions-" })).pipe(
    Effect.orDie,
    Effect.provide(NodeFileSystem.layer),
  ),
)
const StoreLive = SessionStoreFs(dir).pipe(
  Layer.provideMerge(NodeFileSystem.layer),
  Layer.provide(cryptoWeb),
)

it.layer(StoreLive)("SessionStoreFs", (it) => {
  it.effect("persists events and reloads to the same projection (replay)", () =>
    Effect.gen(function* () {
      yield* appendAll("a")

      const reopened = yield* Effect.provide(
        Effect.gen(function* () {
          const events = (yield* (yield* SessionStore).load("a")).events
          const messages = yield* (yield* SessionStore).deriveMessages("a")
          return [events, messages] as const
        }),
        SessionStoreFs(dir).pipe(Layer.provide(NodeFileSystem.layer), Layer.provide(cryptoWeb)),
      )
      const [events, messages] = reopened
      assert.strictEqual(events.length, scripted.length)
      assert.deepStrictEqual(messages, deriveMessages(scripted))

      const metas = yield* (yield* SessionStore).list
      assert.deepStrictEqual(
        metas.map((meta) => [meta.id, meta.title]),
        [["a", "first question"]],
      )
    }),
  )

  it.effect("load of a missing session fails with SessionNotFound", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit((yield* SessionStore).load("missing"))
      assert.ok(Exit.isFailure(exit))
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      const failure = Option.getOrThrow(Exit.findErrorOption(exit)) as { _tag: string }
      assert.strictEqual(failure._tag, "SessionNotFound")
    }),
  )

  it.effect("append to an existing session keeps prior events", () =>
    Effect.gen(function* () {
      yield* appendAll("grow")
      yield* (yield* SessionStore).append("grow", { _tag: "user/message", content: "more" })

      const session = yield* (yield* SessionStore).load("grow")
      assert.strictEqual(session.events.length, scripted.length + 1)
      assert.deepStrictEqual(session.events[scripted.length], {
        _tag: "user/message",
        content: "more",
      })
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

  // A read permission error (EACCES) on append must die as a defect, not be
  // misread as SessionNotFound and silently reset the log. No-op when
  // permission bits are not enforced (root, Windows).
  const uid = process.getuid?.()
  const permissionEnforced = uid !== undefined && uid !== 0 && process.platform !== "win32"
  it.effect("append dies (does not reset) when the log is unreadable", () => {
    const lockedDir = `${dir}/locked`
    const LockedStore = SessionStoreFs(lockedDir).pipe(
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
          (yield* SessionStore).append("locked-session", {
            _tag: "user/message",
            content: "should not land",
          }),
        ).pipe(Effect.onExit(() => fs.chmod(lockedDir, 0o700)))
        assert.ok(Exit.isFailure(exit))
        assert.ok(exit.cause.reasons.some(Cause.isDieReason))
      }),
      LockedStore,
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
      })
      yield* fs.writeFileString(`${dir}/future.json`, json)

      const store = yield* SessionStore
      const exit = yield* Effect.exit(store.load("future"))
      assert.ok(Exit.isFailure(exit))
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      const failure = Option.getOrThrow(Exit.findErrorOption(exit)) as {
        _tag: string
        message: string
      }
      assert.strictEqual(failure._tag, "SessionFormatError")
      assert.match(failure.message, /version 2/)

      const derived = yield* Effect.exit(store.deriveMessages("future"))
      assert.ok(Exit.isFailure(derived))
    }),
  )

  it.effect("list skips corrupt sessions and returns the valid ones", () =>
    Effect.gen(function* () {
      yield* appendAll("good")
      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFileString(`${dir}/broken.json`, "{not json")
      // A percent-encoded session id can still be malformed after decoding.
      yield* fs.writeFileString(`${dir}/%E0%A4%A.json`, "{}")

      const metas = yield* (yield* SessionStore).list
      // timestamps can collide within a millisecond, so only assert membership
      assert.deepStrictEqual(metas.map((meta) => meta.id).sort(), ["a", "good", "grow", "tmpcheck"])
    }),
  )

  it.effect("rejects a log that fails validation", () =>
    Effect.gen(function* () {
      yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.writeFileString(`${dir}/corrupt.json`, "{not json")),
      )

      const exit = yield* Effect.exit((yield* SessionStore).load("corrupt"))
      assert.ok(Exit.isFailure(exit))
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      const failure = Option.getOrThrow(Exit.findErrorOption(exit)) as { _tag: string }
      assert.strictEqual(failure._tag, "SessionFormatError")
    }),
  )

  it.effect("fork copies history into a new session", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore
      yield* appendAll("orig")

      const forkedMeta = yield* store.fork("orig", "forked")
      assert.strictEqual(forkedMeta.id, "forked")
      assert.strictEqual(forkedMeta.title, "first question")

      const forkedSession = yield* store.load("forked")
      assert.strictEqual(forkedSession.events.length, scripted.length)
      assert.strictEqual(forkedSession.id, "forked")

      // Appending to forked doesn't affect original
      yield* store.append("forked", { _tag: "user/message", content: "forked question" })
      const origAfter = yield* store.load("orig")
      const forkedAfter = yield* store.load("forked")
      assert.strictEqual(origAfter.events.length, scripted.length)
      assert.strictEqual(forkedAfter.events.length, scripted.length + 1)
    }),
  )

  it.effect("preserves encoded session ids and serializes concurrent appends", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore
      const sessionId = "unicode/セッション?"
      const events = Array.from({ length: 12 }, (_, index) => ({
        _tag: "user/message" as const,
        content: `message-${index}`,
      }))
      yield* Effect.all(
        events.map((event) => store.append(sessionId, event)),
        { concurrency: "unbounded", discard: true },
      )
      const session = yield* store.load(sessionId)
      assert.strictEqual(session.events.length, events.length)
      assert.deepStrictEqual(
        session.events.map((event) => (event._tag === "user/message" ? event.content : "")).sort(),
        events.map((event) => event.content).sort(),
      )
    }),
  )

  it.effect("rejects concurrent forks that target the same session id", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore
      yield* appendAll("fork-source")
      const results = yield* Effect.all(
        [0, 1].map(() => Effect.exit(store.fork("fork-source", "fork-target"))),
        { concurrency: "unbounded" },
      )
      assert.strictEqual(results.filter(Exit.isSuccess).length, 1)
      assert.strictEqual(results.filter(Exit.isFailure).length, 1)
      const failure = results.find(Exit.isFailure)!
      /* SAFETY: The failed concurrent fork is the duplicate-target case, whose
       * tagged error is inspected below. */
      const error = Option.getOrThrow(Exit.findErrorOption(failure)) as { _tag: string }
      assert.strictEqual(error._tag, "SessionAlreadyExists")
    }),
  )
})
