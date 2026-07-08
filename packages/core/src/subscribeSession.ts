import { Effect, Fiber, Queue, Stream } from "effect"

import { SessionHub } from "./SessionHub.ts"
import { SessionNotFound, SessionStore, type SessionRecord } from "./SessionStore.ts"

export type SubscribeSessionOptions = {
  readonly sessionId: string
  /** Exclusive cursor; unknown id → full replay. */
  readonly afterRecordId?: string | undefined
}

/**
 * Race-safe live tail: buffer hub before store snapshot, emit backlog then
 * deduped live records. Fails with `SessionNotFound` if the session is missing.
 */
export const subscribeSession = (
  options: SubscribeSessionOptions,
): Stream.Stream<SessionRecord, SessionNotFound, SessionStore | SessionHub> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const store = yield* SessionStore
      const hub = yield* SessionHub
      const { sessionId, afterRecordId } = options

      // Pump hub before snapshot so concurrent appends are not missed.
      const buffer = yield* Queue.unbounded<SessionRecord>()
      const pump = yield* hub.subscribe(sessionId).pipe(
        Stream.runForEach((record) => Queue.offer(buffer, record)),
        Effect.forkDetach({ startImmediately: true }),
      )

      const session = yield* store
        .get(sessionId)
        .pipe(
          Effect.onExit((exit) =>
            exit._tag === "Failure" ? Fiber.interrupt(pump).pipe(Effect.asVoid) : Effect.void,
          ),
        )

      let startIndex = 0
      if (afterRecordId !== undefined) {
        const idx = session.records.findIndex((record) => record.id === afterRecordId)
        startIndex = idx >= 0 ? idx + 1 : 0
      }

      const backlog = session.records.slice(startIndex)
      const seen = new Set(backlog.map((record) => record.id))

      const live = Stream.fromQueue(buffer).pipe(
        Stream.filter((record) => {
          if (seen.has(record.id)) {
            return false
          }
          seen.add(record.id)
          return true
        }),
        Stream.ensuring(Fiber.interrupt(pump).pipe(Effect.asVoid)),
      )

      return Stream.concat(Stream.fromIterable(backlog), live)
    }),
  )
