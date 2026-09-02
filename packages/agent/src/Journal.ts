import { Context, Effect, Layer, Ref, Schema } from "effect"

import { SessionId } from "./DomainIds.ts"
import { decodeJournalEvent, JournalEvent } from "./Event.ts"

export type Revision = number

export interface JournalSnapshot {
  readonly sessionId: SessionId
  readonly revision: Revision
  readonly events: ReadonlyArray<JournalEvent>
}

/** The wire-safe snapshot returned by host adapters. */
export const JournalSnapshotSchema = Schema.Struct({
  sessionId: SessionId,
  revision: Schema.Finite,
  events: Schema.Array(JournalEvent),
})
export type JournalSnapshotEncoded = typeof JournalSnapshotSchema.Type

export class JournalError extends Schema.TaggedErrorClass<JournalError>()("JournalError", {
  operation: Schema.Literals(["load", "append", "decode"]),
  sessionId: SessionId,
  detail: Schema.optionalKey(Schema.String),
}) {
  override get message(): string {
    return `Journal operation '${this.operation}' failed for session '${this.sessionId}'${this.detail !== undefined ? `: ${this.detail}` : ""}`
  }
}

export class JournalRevisionConflict extends Schema.TaggedErrorClass<JournalRevisionConflict>()(
  "JournalRevisionConflict",
  {
    sessionId: SessionId,
    expectedRevision: Schema.Finite,
    actualRevision: Schema.Finite,
  },
) {
  override get message(): string {
    return `Revision conflict for session '${this.sessionId}': expected ${this.expectedRevision}, got ${this.actualRevision}`
  }
}

export class JournalEmptyAppend extends Schema.TaggedErrorClass<JournalEmptyAppend>()(
  "JournalEmptyAppend",
  { sessionId: SessionId },
) {
  override get message(): string {
    return `Cannot append empty events list for session '${this.sessionId}'`
  }
}

export class JournalFutureVersion extends Schema.TaggedErrorClass<JournalFutureVersion>()(
  "JournalFutureVersion",
  { sessionId: SessionId, version: Schema.Finite },
) {
  override get message(): string {
    return `Future event version ${this.version} is not supported for session '${this.sessionId}'`
  }
}

export type JournalAppendError =
  | JournalError
  | JournalRevisionConflict
  | JournalEmptyAppend
  | JournalFutureVersion

export type JournalLoadError = JournalError | JournalFutureVersion

export interface JournalService {
  readonly load: (sessionId: SessionId | string) => Effect.Effect<JournalSnapshot, JournalLoadError>
  readonly append: (
    sessionId: SessionId | string,
    expectedRevision: Revision,
    events: readonly [JournalEvent, ...JournalEvent[]],
  ) => Effect.Effect<Revision, JournalAppendError>
}

/** Durable, revisioned storage for the semantic events of a session. */
export class Journal extends Context.Service<Journal, JournalService>()("roop/Journal") {}

/** Validate an event at a dynamic boundary using Effect Schema. */
export const validateJournalEvent = Effect.fn("Journal.validateJournalEvent")(function* (
  sessionId: SessionId | string,
  event: JournalEvent,
) {
  const sid = SessionId.make(sessionId)
  if (event.version > 1) {
    return yield* new JournalFutureVersion({ sessionId: sid, version: event.version })
  }
  return yield* decodeJournalEvent(event).pipe(
    Effect.mapError(
      (parseError) =>
        new JournalError({ operation: "decode", sessionId: sid, detail: parseError.message }),
    ),
  )
})

const emptySnapshot = (sessionId: SessionId): JournalSnapshot => ({
  sessionId,
  revision: 0,
  events: [],
})

/** The in-memory provider: the only storage provider owned by the kernel. */
export const memory: Layer.Layer<Journal> = Layer.effect(
  Journal,
  Effect.gen(function* () {
    const sessions = yield* Ref.make(new Map<string, JournalSnapshot>())

    const load = Effect.fn("JournalMemory.load")(function* (sessionId: SessionId | string) {
      const map = yield* Ref.get(sessions)
      return map.get(sessionId) ?? emptySnapshot(SessionId.make(sessionId))
    })

    const append = Effect.fn("JournalMemory.append")(function* (
      sessionId: SessionId | string,
      expectedRevision: Revision,
      events: readonly [JournalEvent, ...JournalEvent[]],
    ) {
      const sid = SessionId.make(sessionId)
      if (events.length === 0) return yield* new JournalEmptyAppend({ sessionId: sid })
      // Validate every event before changing the map. This keeps a batch atomic.
      yield* Effect.forEach(events, (event) => validateJournalEvent(sid, event), {
        discard: true,
      })
      const outcome = yield* Ref.modify(
        sessions,
        (map): readonly [Revision | JournalRevisionConflict, Map<string, JournalSnapshot>] => {
          const latest = map.get(sid) ?? emptySnapshot(sid)
          if (latest.revision !== expectedRevision) {
            const conflict = new JournalRevisionConflict({
              sessionId: sid,
              expectedRevision,
              actualRevision: latest.revision,
            })
            return [conflict, map]
          }
          const revision = latest.revision + events.length
          return [
            revision,
            new Map(map).set(sid, {
              sessionId: sid,
              revision,
              events: [...latest.events, ...events],
            }),
          ]
        },
      )
      return typeof outcome === "number" ? outcome : yield* outcome
    })

    return Journal.of({ load, append })
  }),
)
