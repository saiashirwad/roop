import { Cause, Result, Schema } from "effect"

/** A typed operational failure emitted by the run stream. */
export class RunError extends Schema.TaggedErrorClass<RunError>()("RunError", {
  operation: Schema.Literals(["model", "tool", "scheduler", "journal", "interpreter", "unknown"]),
  originalCause: Schema.Unknown,
  context: Schema.Unknown,
}) {}

/** Preserve an arbitrary Effect failure while giving callers a stable error tag. */
export interface RunErrorContext {
  readonly sessionId?: string
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
