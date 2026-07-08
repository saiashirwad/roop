/** Store-agnostic conformance scenarios for every `SessionStore` backend. */
import { Effect } from "effect"

import { type SessionNotFound, SessionStore } from "./SessionStore.ts"

export type SessionStoreScenario = {
  readonly name: string
  readonly run: Effect.Effect<void, SessionNotFound, SessionStore>
}

const check: (condition: boolean, message: string) => asserts condition = (condition, message) => {
  if (!condition) {
    throw new Error(message)
  }
}

const checkEqual = (actual: unknown, expected: unknown, label: string): void =>
  check(
    actual === expected,
    `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  )

/** Real-clock pause so consecutive `Date.now()` stamps differ (safe under TestClock). */
const tick = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)))

const expectNotFound = <A>(
  effect: Effect.Effect<A, SessionNotFound, SessionStore>,
  label: string,
): Effect.Effect<SessionNotFound, never, SessionStore> =>
  effect.pipe(
    Effect.flip,
    Effect.catch(() => Effect.die(new Error(`${label}: expected SessionNotFound, got success`))),
  )

export const sessionStoreScenarios: ReadonlyArray<SessionStoreScenario> = [
  {
    name: "create returns an empty main-session summary that get can read back",
    run: Effect.gen(function* () {
      const store = yield* SessionStore
      const created = yield* store.create()

      check(created.id.length > 0, "created summary must carry a session id")
      checkEqual(created.recordCount, 0, "new session recordCount")
      checkEqual(created.kind, "main", "default session kind")
      checkEqual(created.updatedAt, created.createdAt, "empty session updatedAt")

      const session = yield* store.get(created.id)
      checkEqual(session.records.length, 0, "new session records")
      checkEqual(session.createdAt, created.createdAt, "persisted createdAt")
    }),
  },
  {
    name: "append returns the exact record that get later replays",
    run: Effect.gen(function* () {
      const store = yield* SessionStore
      const created = yield* store.create()
      const appended = yield* store.append(created.id, { _tag: "UserPrompt", prompt: "hello" })

      check(appended.id.length > 0, "appended record must carry an id")
      checkEqual(appended.sessionId, created.id, "record sessionId")

      const session = yield* store.get(created.id)
      const replayed = session.records[0]
      check(replayed !== undefined, "appended record must be readable")
      checkEqual(replayed.id, appended.id, "record id round-trip")
      checkEqual(replayed.createdAt, appended.createdAt, "record createdAt round-trip")
      checkEqual(replayed.entry._tag, "UserPrompt", "record entry tag")
      check(
        replayed.entry._tag === "UserPrompt" && replayed.entry.prompt === "hello",
        "record entry payload round-trip",
      )
    }),
  },
  {
    name: "get preserves append order with unique record ids",
    run: Effect.gen(function* () {
      const store = yield* SessionStore
      const created = yield* store.create()
      for (const i of [0, 1, 2, 3, 4]) {
        yield* store.append(created.id, { _tag: "UserPrompt", prompt: `p-${i}` })
      }

      const session = yield* store.get(created.id)
      const prompts = session.records.map((record) =>
        record.entry._tag === "UserPrompt" ? record.entry.prompt : record.entry._tag,
      )
      checkEqual(prompts.join(","), "p-0,p-1,p-2,p-3,p-4", "append order")
      checkEqual(new Set(session.records.map((r) => r.id)).size, 5, "record id uniqueness")
    }),
  },
  {
    name: "list derives title from the first user prompt and counts records",
    run: Effect.gen(function* () {
      const store = yield* SessionStore
      const created = yield* store.create()
      yield* store.append(created.id, {
        _tag: "Agent",
        event: { _tag: "RunStarted", runId: "run-1", sessionId: created.id },
      })
      yield* store.append(created.id, { _tag: "UserPrompt", prompt: "fix the tests" })
      yield* store.append(created.id, { _tag: "Agent", event: { _tag: "RunCompleted" } })

      const listed = (yield* store.list()).find((summary) => summary.id === created.id)
      check(listed !== undefined, "created session must be listed")
      checkEqual(listed.title, "fix the tests", "title from first user prompt")
      checkEqual(listed.recordCount, 3, "listed recordCount")
    }),
  },
  {
    name: "list orders sessions by updatedAt descending",
    run: Effect.gen(function* () {
      const store = yield* SessionStore
      const first = yield* store.create()
      yield* tick
      const second = yield* store.create()
      yield* tick
      yield* store.append(first.id, { _tag: "UserPrompt", prompt: "bump" })

      const ids = (yield* store.list()).map((summary) => summary.id)
      check(
        ids.indexOf(first.id) < ids.indexOf(second.id),
        "session appended last must list before an older session",
      )
    }),
  },
  {
    name: "create persists subagent meta and explicit titles",
    run: Effect.gen(function* () {
      const store = yield* SessionStore
      const parent = yield* store.create({ kind: "main" })
      const child = yield* store.create({
        kind: "subagent",
        parentSessionId: parent.id,
        agentId: "explore",
        title: "explore: find stuff",
      })
      yield* store.append(child.id, { _tag: "UserPrompt", prompt: "not the title" })

      const session = yield* store.get(child.id)
      checkEqual(session.kind, "subagent", "child kind")
      checkEqual(session.parentSessionId, parent.id, "child parentSessionId")
      checkEqual(session.agentId, "explore", "child agentId")

      const listed = (yield* store.list()).find((summary) => summary.id === child.id)
      check(listed !== undefined, "child session must be listed")
      checkEqual(listed.kind, "subagent", "listed child kind")
      checkEqual(listed.title, "explore: find stuff", "explicit title wins over prompt")
    }),
  },
  {
    name: "get on a missing session fails with SessionNotFound",
    run: Effect.gen(function* () {
      const store = yield* SessionStore
      const failure = yield* expectNotFound(store.get("missing-get"), "get(missing)")
      checkEqual(failure._tag, "SessionNotFound", "get failure tag")
      checkEqual(failure.sessionId, "missing-get", "get failure sessionId")
    }),
  },
  {
    name: "append to a missing session fails with SessionNotFound",
    run: Effect.gen(function* () {
      const store = yield* SessionStore
      const failure = yield* expectNotFound(
        store.append("missing-append", { _tag: "UserPrompt", prompt: "x" }),
        "append(missing)",
      )
      checkEqual(failure._tag, "SessionNotFound", "append failure tag")
      checkEqual(failure.sessionId, "missing-append", "append failure sessionId")
    }),
  },
  {
    name: "concurrent appends keep every record",
    run: Effect.gen(function* () {
      const store = yield* SessionStore
      const created = yield* store.create()

      yield* Effect.forEach(
        Array.from({ length: 40 }, (_, i) => i),
        (i) => store.append(created.id, { _tag: "UserPrompt", prompt: `n-${i}` }),
        { concurrency: "unbounded" },
      )

      const session = yield* store.get(created.id)
      checkEqual(session.records.length, 40, "record count after concurrent appends")
      const prompts = new Set(
        session.records.map((record) =>
          record.entry._tag === "UserPrompt" ? record.entry.prompt : "",
        ),
      )
      checkEqual(prompts.size, 40, "distinct prompts after concurrent appends")
    }),
  },
]
