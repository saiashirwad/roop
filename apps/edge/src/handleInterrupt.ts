import { Effect } from "effect"
import { handler } from "liminal/Method"

import { Interrupt } from "./external.ts"
import { PromptQueue } from "./services/PromptQueue.ts"

/** Interrupt the active agent run, if any. */
export default handler(
  Interrupt,
  Effect.fn(function* (_payload) {
    const queue = yield* PromptQueue
    yield* queue.interrupt()
  }),
)
