import { Schema } from "effect"

/** Public U3 error contract. Legacy RunError remains as the implementation. */
export * from "./RunError.ts"

/** A terminal Journal failure that preserves the original typed failure. */
export class FinalizationError extends Schema.TaggedErrorClass<FinalizationError>()(
  "FinalizationError",
  {
    sessionId: Schema.String,
    primary: Schema.Unknown,
    journal: Schema.Unknown,
  },
) {}

/** Middleware tried to start a new physical attempt after model output became visible. */
export class UnsafeModelRetry extends Schema.TaggedErrorClass<UnsafeModelRetry>()(
  "UnsafeModelRetry",
  {
    sessionId: Schema.String,
    turn: Schema.Finite,
    step: Schema.Finite,
    attempt: Schema.Finite,
  },
) {}
