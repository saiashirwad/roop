import { Context, Effect, Layer, Stream } from "effect"

import { SessionHub } from "./SessionHub.ts"
import {
  SessionNotFound,
  SessionStore,
  type Session,
  type SessionCreateOptions,
  type SessionRecord,
  type SessionSummary,
} from "./SessionStore.ts"
import { subscribeSession, type SubscribeSessionOptions } from "./subscribeSession.ts"

/** Session API: durable store + hub publish on append; store/hub stay internal. */
export class SessionLog extends Context.Service<
  SessionLog,
  {
    readonly create: (options?: SessionCreateOptions) => Effect.Effect<SessionSummary>
    readonly append: (
      sessionId: string,
      entry: SessionRecord["entry"],
    ) => Effect.Effect<SessionRecord, SessionNotFound>
    readonly get: (sessionId: string) => Effect.Effect<Session, SessionNotFound>
    readonly list: () => Effect.Effect<ReadonlyArray<SessionSummary>>
    readonly subscribe: (
      options: SubscribeSessionOptions,
    ) => Stream.Stream<SessionRecord, SessionNotFound>
  }
>()("roop/SessionLog") {}

export const SessionLogLive = Layer.effect(
  SessionLog,
  Effect.gen(function* () {
    const store = yield* SessionStore
    const hub = yield* SessionHub

    return SessionLog.of({
      create: (options) => store.create(options),
      get: (sessionId) => store.get(sessionId),
      list: () => store.list(),
      append: (sessionId, entry) =>
        Effect.gen(function* () {
          const record = yield* store.append(sessionId, entry)
          yield* hub.publish(record)
          return record
        }),
      subscribe: (options) =>
        subscribeSession(options).pipe(
          Stream.provideService(SessionStore, store),
          Stream.provideService(SessionHub, hub),
        ),
    })
  }),
)
