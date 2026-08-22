import { Context, Effect, Schema } from "effect"

import { SessionId } from "./DomainIds.ts"
import { JournalEvent, type JournalEvent as JournalEventValue } from "./Event.ts"

export type Revision = number

export interface JournalSnapshot {
  readonly sessionId: SessionId
  readonly revision: Revision
  readonly events: ReadonlyArray<JournalEventValue>
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

/** Alias used by callers that prefer the shorter domain name. */
export const JournalConflict = JournalRevisionConflict

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
    events: readonly [JournalEventValue, ...JournalEventValue[]],
  ) => Effect.Effect<Revision, JournalAppendError>
}

export class Journal extends Context.Service<Journal, JournalService>()("roop/Journal") {}

/** Validate an event at a dynamic boundary, including the version pin. */
export const validateJournalEvent = Effect.fn("Journal.validateJournalEvent")(function* (
  sessionId: SessionId | string,
  event: JournalEventValue,
) {
  const sid = SessionId.is(sessionId) ? sessionId : SessionId.make(sessionId)
  if (event.version > 1) {
    return yield* new JournalFutureVersion({ sessionId: sid, version: event.version })
  }
  if (!Schema.is(JournalEvent)(event)) {
    return yield* new JournalError({
      operation: "decode",
      sessionId: sid,
      detail: "event does not match the supported JournalEvent schema",
    })
  }
  return event
})
