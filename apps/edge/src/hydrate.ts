import { Effect } from "effect"
import { DoState } from "effect-workerd"

import { RoomActor } from "./RoomActor.ts"
import type { RoomClient } from "./RoomClient.ts"
import { lastSeq, recentChat, recordsAfter } from "./sqlStore.ts"
import { PromptQueue } from "./services/PromptQueue.ts"

/** Collect `{ id, name }` for every open client socket. */
const membersFromClients = Effect.gen(function* () {
  const { clients } = yield* RoomActor
  const members: Array<{ id: string; name: string }> = []
  for (const client of clients) {
    const { actorId, name } = yield* client.attachments
    members.push({ id: actorId, name })
  }
  return members
})

/**
 * Initial client state on WebSocket audition success.
 *
 * Replays session records after the client's `after` cursor as `Record` events,
 * then broadcasts presence so other members see the join.
 */
export default Effect.gen(function* () {
  const { currentClient } = yield* RoomActor
  const attachments = yield* currentClient.attachments
  const { actorId, name } = attachments
  const after = attachments.after ?? 0

  const state = yield* DoState.DoState
  const sql = state.storage.sql
  const sessionId = state.id.toString()
  const members = yield* membersFromClients

  const queue = yield* PromptQueue
  const running = yield* queue.isRunning

  // Catch-up: emit Record events for this client only (not a full room broadcast).
  for (const { seq, record } of recordsAfter(sql, sessionId, after)) {
    yield* currentClient.send("Record", { seq, record })
  }

  // Human chat backlog (last N) — separate from agent session log.
  for (const row of recentChat(sql)) {
    yield* currentClient.send("Chat", row)
  }

  // Announce join to the room (includes self).
  yield* RoomActor.all.send("Presence", { members })

  yield* Effect.addFinalizer(() =>
    membersFromClients.pipe(
      Effect.flatMap((latest) => RoomActor.all.send("Presence", { members: latest })),
      Effect.orDie,
    ),
  )

  return {
    self: { id: actorId, name },
    members,
    cursor: lastSeq(sql),
    running,
  } satisfies RoomClient["State"]
}).pipe(Effect.orDie)
