import { Schema as S } from "effect"
import * as Actor from "liminal/Actor"

import { RoomClient } from "./RoomClient.ts"

/**
 * One Durable Object room. `name` is the room id (`idFromName`).
 * Attachments carry identity + optional resume cursor per socket.
 */
export class RoomActor extends Actor.Service<RoomActor>()("roop/RoomActor", {
  client: RoomClient,
  name: S.String,
  attachments: {
    /** Stable id for this connection (generated at upgrade). */
    actorId: S.String,
    /** Display name. */
    name: S.String,
    /** Optional session-log cursor for backlog replay. */
    after: S.optionalKey(S.Number),
  },
}) {}
