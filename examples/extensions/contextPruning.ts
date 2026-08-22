import { Middleware } from "@roop/agent"
import type { Prompt } from "effect/unstable/ai"

/** Rewrite only the prompt sent to the model. The journal remains unchanged. */
export const contextPruning = (
  prune: (prompt: Prompt.Prompt) => Prompt.Prompt,
): Middleware.Middleware =>
  Middleware.make({
    model: (next) => (input) => next({ ...input, prompt: prune(input.prompt) }),
  })
