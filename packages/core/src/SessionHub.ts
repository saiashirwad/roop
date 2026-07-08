import { Context, Effect, Layer, PubSub, Stream } from "effect"

import type { SessionRecord } from "./SessionStore.ts"

/** Live fan-out of session records (no history replay — pair with `subscribeSession`). */
export class SessionHub extends Context.Service<
  SessionHub,
  {
    readonly publish: (record: SessionRecord) => Effect.Effect<void>
    readonly subscribe: (sessionId: string) => Stream.Stream<SessionRecord>
  }
>()("roop/SessionHub") {}

/** In-process unbounded PubSub so slow clients don't drop deltas. */
export const SessionHubLive = Layer.effect(
  SessionHub,
  Effect.gen(function* () {
    const hub = yield* PubSub.unbounded<SessionRecord>()

    return SessionHub.of({
      publish: (record) => PubSub.publish(hub, record).pipe(Effect.asVoid),
      subscribe: (sessionId) =>
        Stream.fromPubSub(hub).pipe(Stream.filter((record) => record.sessionId === sessionId)),
    })
  }),
)

/** No-op hub for runtimes without live sync (`session.hub: "none"`). */
export const SessionHubNoneLive = Layer.succeed(
  SessionHub,
  SessionHub.of({
    publish: () => Effect.void,
    subscribe: () => Stream.never,
  }),
)
