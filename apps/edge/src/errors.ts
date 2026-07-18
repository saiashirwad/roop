import { Schema as S } from "effect"

/** Raised when a prompt cannot be accepted (empty, no model, queue full, etc.). */
export class PromptError extends S.TaggedErrorClass<PromptError>()("PromptError", {
  message: S.String,
}) {}
