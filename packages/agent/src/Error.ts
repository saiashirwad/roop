import { Cause, Result, Schema } from "effect"

import { SessionId } from "./DomainIds.ts"

/** A typed operational failure emitted by the run stream. */
export class RunError extends Schema.TaggedErrorClass<RunError>()("RunError", {
  operation: Schema.Literals(["model", "tool", "scheduler", "journal", "interpreter", "unknown"]),
  originalCause: Schema.Unknown,
  context: Schema.Unknown,
}) {
  override get message(): string {
    return `Run error during ${this.operation}`
  }
}

/** Preserve an arbitrary Effect failure while giving callers a stable error tag. */
export interface RunErrorContext {
  readonly sessionId?: SessionId | string | undefined
}

/**
 * Wrap a failure at an explicit interpreter boundary.
 *
 * The operation is supplied by the caller. This function deliberately does
 * not inspect `_tag`: extension errors are not a closed catalogue and string
 * matching misclassifies them.
 */
export const runError = (
  cause: unknown,
  context: RunErrorContext = {},
  operation: RunError["operation"] = "interpreter",
): RunError => {
  const original = Cause.isCause(cause)
    ? (() => {
        const found = Cause.findError(cause)
        return Result.isSuccess(found) ? found.success : cause
      })()
    : cause
  return new RunError({ operation, originalCause: original, context })
}

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
