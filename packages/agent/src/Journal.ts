import { Clock, Context, Effect, Layer, Option, Ref, Schema } from "effect"

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

/**
 * One stored session as reported by `Journal.list`. Timestamps are epoch
 * milliseconds recorded by the provider: `createdAt` at the first append and
 * `updatedAt` at the latest. `title` and `cwd` come from `session/meta` events.
 *
 * The same schema is the wire shape: absent metadata is an omitted key.
 */
export const SessionSummarySchema = Schema.Struct({
  sessionId: SessionId,
  revision: Schema.Finite,
  createdAt: Schema.Finite,
  updatedAt: Schema.Finite,
  title: Schema.OptionFromOptionalKey(Schema.String),
  cwd: Schema.OptionFromOptionalKey(Schema.String),
})
export type SessionSummary = typeof SessionSummarySchema.Type
export type SessionSummaryEncoded = typeof SessionSummarySchema.Encoded

/** The metadata fields a session list shows. */
export interface SessionMetadata {
  readonly title: Option.Option<string>
  readonly cwd: Option.Option<string>
}

export const emptySessionMetadata: SessionMetadata = {
  title: Option.none(),
  cwd: Option.none(),
}

/**
 * Fold `session/meta` events over existing metadata. The latest value of each
 * field wins; a field left out of an event keeps its previous value.
 */
export const foldSessionMetadata = (
  initial: SessionMetadata,
  events: ReadonlyArray<JournalEvent>,
): SessionMetadata => {
  let current = initial
  for (const event of events) {
    if (event._tag !== "session/meta") continue
    current = {
      title: event.title === undefined ? current.title : Option.some(event.title),
      cwd: event.cwd === undefined ? current.cwd : Option.some(event.cwd),
    }
  }
  return current
}

export class JournalError extends Schema.TaggedErrorClass<JournalError>()("JournalError", {
  operation: Schema.Literals(["load", "append", "decode", "list", "delete"]),
  sessionId: Schema.optionalKey(SessionId),
  detail: Schema.optionalKey(Schema.String),
}) {
  override get message(): string {
    const subject = this.sessionId === undefined ? "" : ` for session '${this.sessionId}'`
    return `Journal operation '${this.operation}' failed${subject}${this.detail !== undefined ? `: ${this.detail}` : ""}`
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
  /** Every stored session. Sessions with no committed events are not stored. */
  readonly list: Effect.Effect<ReadonlyArray<SessionSummary>, JournalError>
  /** Remove a session and its events. Deleting a missing session is a no-op. */
  readonly delete: (sessionId: SessionId | string) => Effect.Effect<void, JournalError>
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

interface MemorySession {
  readonly snapshot: JournalSnapshot
  readonly createdAt: number
  readonly updatedAt: number
  readonly metadata: SessionMetadata
}

/** The in-memory provider: the only storage provider owned by the kernel. */
export const memory: Layer.Layer<Journal> = Layer.effect(
  Journal,
  Effect.gen(function* () {
    const sessions = yield* Ref.make(new Map<string, MemorySession>())

    const load = Effect.fn("JournalMemory.load")(function* (sessionId: SessionId | string) {
      const map = yield* Ref.get(sessions)
      return map.get(sessionId)?.snapshot ?? emptySnapshot(SessionId.make(sessionId))
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
      const now = yield* Clock.currentTimeMillis
      const outcome = yield* Ref.modify(
        sessions,
        (map): readonly [Revision | JournalRevisionConflict, Map<string, MemorySession>] => {
          const existing = map.get(sid)
          const latest = existing?.snapshot ?? emptySnapshot(sid)
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
              snapshot: { sessionId: sid, revision, events: [...latest.events, ...events] },
              createdAt: existing?.createdAt ?? now,
              updatedAt: now,
              metadata: foldSessionMetadata(existing?.metadata ?? emptySessionMetadata, events),
            }),
          ]
        },
      )
      return typeof outcome === "number" ? outcome : yield* outcome
    })

    const list = Ref.get(sessions).pipe(
      Effect.map((map) =>
        [...map.values()].map(
          (session): SessionSummary => ({
            sessionId: session.snapshot.sessionId,
            revision: session.snapshot.revision,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            title: session.metadata.title,
            cwd: session.metadata.cwd,
          }),
        ),
      ),
      Effect.withSpan("JournalMemory.list"),
    )

    const remove = Effect.fn("JournalMemory.delete")(function* (sessionId: SessionId | string) {
      yield* Ref.update(sessions, (map) => {
        if (!map.has(sessionId)) return map
        const next = new Map(map)
        next.delete(sessionId)
        return next
      })
    })

    return Journal.of({ load, append, list, delete: remove })
  }),
)
