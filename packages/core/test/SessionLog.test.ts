import { assert, it } from "@effect/vitest"
import { Effect, Fiber, Layer, Stream } from "effect"

import { SessionHub, SessionHubLive } from "../src/SessionHub.ts"
import { SessionLog, SessionLogLive } from "../src/SessionLog.ts"
import { SessionStoreMemoryLive } from "../src/SessionStore.ts"

const Base = Layer.mergeAll(SessionStoreMemoryLive, SessionHubLive)
const LogTestLive = SessionLogLive.pipe(Layer.provideMerge(Base))

it.layer(LogTestLive)("SessionLog", (it) => {
  it.effect("append is durable and published to the hub", () =>
    Effect.gen(function* () {
      const log = yield* SessionLog
      const hub = yield* SessionHub
      const created = yield* log.create()

      const fiber = yield* Stream.runCollect(Stream.take(hub.subscribe(created.id), 1)).pipe(
        Effect.forkChild,
      )
      yield* Effect.yieldNow

      const record = yield* log.append(created.id, { _tag: "UserPrompt", prompt: "hello" })

      const session = yield* log.get(created.id)
      assert.strictEqual(session.records.length, 1)
      assert.strictEqual(session.records[0]?.id, record.id)

      const received = yield* Fiber.join(fiber)
      assert.strictEqual(received.length, 1)
      assert.strictEqual(received[0]?.id, record.id)
      assert.strictEqual(received[0]?.entry._tag, "UserPrompt")
    }),
  )
})
