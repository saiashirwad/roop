import { Effect } from "effect"
import { DoState } from "effect-workerd"
import { handler } from "liminal/Method"

import { PromptError } from "./errors.ts"
import { Say } from "./external.ts"
import { RoomActor } from "./RoomActor.ts"
import { insertChat } from "./sqlStore.ts"

/** Human-to-human chat — durable, broadcast to the room, no agent run. */
export default handler(
  Say,
  Effect.fn(function* ({ text }) {
    const trimmed = text.trim()
    if (trimmed.length === 0) {
      return yield* new PromptError({ message: "Chat text must not be empty" })
    }
    if (trimmed.length > 2000) {
      return yield* new PromptError({ message: "Chat text too long (max 2000)" })
    }

    const { currentClient } = yield* RoomActor
    const { actorId, name } = yield* currentClient.attachments
    const state = yield* DoState.DoState

    const id = crypto.randomUUID()
    const at = Date.now()
    const from = { id: actorId, name }
    insertChat(state.storage.sql, { id, from, text: trimmed, at })

    yield* RoomActor.all.send("Chat", { id, from, text: trimmed, at })
  }),
)
