import { Cause, Option, Schema } from "effect"

import { SessionId } from "./DomainIds.ts"

/** The typed error inside a cause, or the cause itself when it holds none. */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- the failure is stored in a Schema.Unknown field for later inspection.
export const originalError = (cause: Cause.Cause<unknown>): unknown =>
  Option.getOrElse(Cause.findErrorOption(cause), () => cause)

/** A terminal Journal failure that preserves the original typed failure. */
export class FinalizationError extends Schema.TaggedErrorClass<FinalizationError>()(
  "FinalizationError",
  {
    sessionId: SessionId,
    primary: Schema.Unknown,
    journal: Schema.Unknown,
  },
) {
  override get message(): string {
    return `Finalization failed for session '${this.sessionId}'`
  }
}

/** Middleware tried to start a new physical attempt after model output became visible. */
export class UnsafeModelRetry extends Schema.TaggedErrorClass<UnsafeModelRetry>()(
  "UnsafeModelRetry",
  {
    sessionId: SessionId,
    turn: Schema.Finite,
    step: Schema.Finite,
    attempt: Schema.Finite,
  },
) {
  override get message(): string {
    return `Unsafe model retry attempted for session '${this.sessionId}' (turn: ${this.turn}, step: ${this.step}, attempt: ${this.attempt})`
  }
}

/** Model execution timed out according to the configured RunPolicy. */
export class ModelTimeout extends Schema.TaggedErrorClass<ModelTimeout>()("ModelTimeout", {
  sessionId: SessionId,
  turn: Schema.Finite,
  step: Schema.Finite,
  durationMillis: Schema.Finite,
}) {
  override get message(): string {
    return `Model request timed out after ${this.durationMillis}ms for session '${this.sessionId}' (turn: ${this.turn}, step: ${this.step})`
  }
}
