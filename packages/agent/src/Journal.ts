import { Context, Effect, Schema } from "effect"

import { JournalEvent, type JournalEvent as JournalEventValue } from "./Event.ts"

export type Revision = number

export interface JournalSnapshot {
  readonly sessionId: string
  readonly revision: Revision
  readonly events: ReadonlyArray<JournalEventValue>
}

export class JournalError extends Schema.TaggedErrorClass<JournalError>()("JournalError", {
  operation: Schema.Literals(["load", "append", "decode"]),
  sessionId: Schema.String,
  message: Schema.String,
}) {}

export class JournalRevisionConflict extends Schema.TaggedErrorClass<JournalRevisionConflict>()(
  "JournalRevisionConflict",
  {
    sessionId: Schema.String,
    expectedRevision: Schema.Finite,
    actualRevision: Schema.Finite,
  },
) {}

/** Alias used by callers that prefer the shorter domain name. */
export const JournalConflict = JournalRevisionConflict

export class JournalEmptyAppend extends Schema.TaggedErrorClass<JournalEmptyAppend>()(
  "JournalEmptyAppend",
  { sessionId: Schema.String },
) {}

export class JournalFutureVersion extends Schema.TaggedErrorClass<JournalFutureVersion>()(
  "JournalFutureVersion",
  { sessionId: Schema.String, version: Schema.Finite },
) {}

export type JournalAppendError =
  | JournalError
  | JournalRevisionConflict
  | JournalEmptyAppend
  | JournalFutureVersion

export type JournalLoadError = JournalError | JournalFutureVersion

export interface JournalService {
  readonly load: (sessionId: string) => Effect.Effect<JournalSnapshot, JournalLoadError>
  readonly append: (
    sessionId: string,
    expectedRevision: Revision,
    events: readonly [JournalEventValue, ...JournalEventValue[]],
  ) => Effect.Effect<Revision, JournalAppendError>
}

export class Journal extends Context.Service<Journal, JournalService>()("roop/Journal") {}

/** Validate an event at a dynamic boundary, including the version pin. */
export const validateJournalEvent = (
  sessionId: string,
  event: JournalEventValue,
): Effect.Effect<JournalEventValue, JournalFutureVersion | JournalError> => {
  if (event.version > 1) {
    return Effect.fail(new JournalFutureVersion({ sessionId, version: event.version }))
  }
  return Schema.is(JournalEvent)(event)
    ? Effect.succeed(event)
    : Effect.fail(
        new JournalError({
          operation: "decode",
          sessionId,
          message: "event does not match the supported JournalEvent schema",
        }),
      )
}
