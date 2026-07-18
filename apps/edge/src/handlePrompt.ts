import { Effect } from "effect"
import { handler } from "liminal/Method"

import { PromptError } from "./errors.ts"
import { Prompt } from "./external.ts"
import { RoomActor } from "./RoomActor.ts"
import { PromptQueue } from "./services/PromptQueue.ts"

/** Enqueue a user prompt on the durable room queue (serialized agent runs). */
export default handler(
  Prompt,
  Effect.fn(function* ({ text }) {
    const trimmed = text.trim()
    if (trimmed.length === 0) {
      return yield* new PromptError({ message: "Prompt text must not be empty" })
    }
    const { currentClient } = yield* RoomActor
    const { actorId, name } = yield* currentClient.attachments
    const queue = yield* PromptQueue
    yield* queue.enqueue({ id: actorId, name }, trimmed)
  }),
)
