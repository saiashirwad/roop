import { Effect } from "effect"

import { RoomActor } from "./RoomActor.ts"

/**
 * Broadcast presence after a client socket drops.
 * `clients` already excludes the disconnected handle when this runs.
 */
export default Effect.gen(function* () {
  const { clients } = yield* RoomActor
  const members: Array<{ id: string; name: string }> = []
  for (const client of clients) {
    const { actorId, name } = yield* client.attachments
    members.push({ id: actorId, name })
  }
  yield* RoomActor.all.send("Presence", { members })
}).pipe(Effect.orDie)
