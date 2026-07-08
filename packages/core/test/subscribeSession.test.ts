import { assert, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Stream } from "effect"

import { SessionHubLive } from "../src/SessionHub.ts"
import { SessionLog, SessionLogLive } from "../src/SessionLog.ts"
import { SessionNotFound, SessionStoreMemoryLive } from "../src/SessionStore.ts"
import { subscribeSession } from "../src/subscribeSession.ts"

const Base = Layer.mergeAll(SessionStoreMemoryLive, SessionHubLive)
const TestLive = SessionLogLive.pipe(Layer.provideMerge(Base))

it.layer(TestLive)("subscribeSession", (it) => {
  it.effect("replays backlog after cursor", () =>
    Effect.gen(function* () {
      const log = yield* SessionLog
      const created = yield* log.create()

      const r1 = yield* log.append(created.id, { _tag: "UserPrompt", prompt: "first" })
      const r2 = yield* log.append(created.id, {
        _tag: "Agent",
        event: { _tag: "RunStarted", runId: "run-1", sessionId: created.id },
      })

      const received = yield* Stream.runCollect(
        Stream.take(subscribeSession({ sessionId: created.id, afterRecordId: r1.id }), 1),
      )

      assert.deepStrictEqual(
        [...received].map((r) => r.id),
        [r2.id],
      )
    }),
  )

  it.effect("streams live appends after the cursor", () =>
    Effect.gen(function* () {
      const log = yield* SessionLog
      const created = yield* log.create()
      const r1 = yield* log.append(created.id, { _tag: "UserPrompt", prompt: "first" })

      const fiber = yield* Effect.forkChild(
        Stream.runCollect(
          Stream.take(subscribeSession({ sessionId: created.id, afterRecordId: r1.id }), 1),
        ),
      )
      yield* Effect.yieldNow
      yield* Effect.yieldNow

      const r2 = yield* log.append(created.id, {
        _tag: "Agent",
        event: { _tag: "RunCompleted" },
      })

      const received = yield* Fiber.join(fiber)
      assert.deepStrictEqual(
        [...received].map((r) => r.id),
        [r2.id],
      )
    }),
  )

  it.effect("unknown cursor replays full log", () =>
    Effect.gen(function* () {
      const log = yield* SessionLog
      const created = yield* log.create()
      const r1 = yield* log.append(created.id, { _tag: "UserPrompt", prompt: "a" })

      const received = yield* Stream.runCollect(
        Stream.take(
          subscribeSession({ sessionId: created.id, afterRecordId: "missing-cursor" }),
          1,
        ),
      )

      assert.strictEqual(received.length, 1)
      assert.strictEqual(received[0]?.id, r1.id)
    }),
  )

  it.effect("missing session fails", () =>
    Effect.gen(function* () {
      const result = yield* Stream.runCollect(
        subscribeSession({ sessionId: "no-such-session" }),
      ).pipe(Effect.flip)

      assert.instanceOf(result, SessionNotFound)
    }),
  )
})
