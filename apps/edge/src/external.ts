import { Schema as S } from "effect"

import { PromptError } from "./errors.ts"

export const Prompt = {
  payload: S.Struct({
    text: S.String,
  }),
  success: S.Void,
  failure: PromptError,
}

/** Human-to-human room chat (does not enqueue an agent run). */
export const Say = {
  payload: S.Struct({
    text: S.String,
  }),
  success: S.Void,
  failure: PromptError,
}

export const Interrupt = {
  payload: S.Struct({}),
  success: S.Void,
  failure: S.Void,
}
