import { Middleware } from "@roop/agent"
import type { Prompt } from "effect/unstable/ai"

/** Apply a public prompt projection before the model call. */
export const toolPruning = (
  prune: (prompt: Prompt.Prompt) => Prompt.Prompt,
): Middleware.Middleware =>
  Middleware.make({
    model: (next) => (input) => next({ ...input, prompt: prune(input.prompt) }),
  })
