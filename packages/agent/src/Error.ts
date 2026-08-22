import { Schema } from "effect"

import { SessionId } from "./DomainIds.ts"

/** Public U3 error contract. Legacy RunError remains as the implementation. */
export * from "./RunError.ts"

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
