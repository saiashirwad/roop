import { assert, it } from "@effect/vitest"
import { Effect, Fiber, Stream } from "effect"

import { SessionHub, SessionHubLive } from "../src/SessionHub.ts"
import type { SessionRecord } from "../src/SessionStore.ts"

const record = (id: string, sessionId: string): SessionRecord => ({
  id,
  sessionId,
  createdAt: Date.now(),
  entry: { _tag: "UserPrompt", prompt: `hi ${id}` },
})

it.layer(SessionHubLive)("SessionHub fans out by session id", (it) => {
  it.effect("subscriber only receives matching session records", () =>
    Effect.gen(function* () {
      const hub = yield* SessionHub

      const fiber = yield* Stream.runCollect(Stream.take(hub.subscribe("s1"), 2)).pipe(
        Effect.forkChild,
      )

      yield* Effect.yieldNow

      yield* hub.publish(record("a", "s1"))
      yield* hub.publish(record("b", "s2"))
      yield* hub.publish(record("c", "s1"))

      const received = yield* Fiber.join(fiber)
      assert.deepStrictEqual(
        [...received].map((r) => r.id),
        ["a", "c"],
      )
    }),
  )
})
