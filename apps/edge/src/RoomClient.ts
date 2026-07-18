import { ActorSchema, SessionRecordSchema } from "@roop/core/SessionStore.ts"
import { Schema as S } from "effect"
import * as Client from "liminal/Client"

import * as external from "./external.ts"

/**
 * Liminal client protocol for a multiplayer room.
 *
 * Wire shape replaces the old ad-hoc JSON `{ type: "prompt" | ... }` protocol
 * in `protocol.ts`. State is delivered via `Audition.Success` (hydrate);
 * presence, session records, and human chat arrive as events.
 */
export class RoomClient extends Client.Service<RoomClient>()("roop/RoomClient", {
  state: {
    self: ActorSchema,
    members: S.Array(ActorSchema),
    cursor: S.Number,
    running: S.Boolean,
  },
  external,
  events: {
    Presence: {
      members: S.Array(ActorSchema),
    },
    Record: {
      seq: S.Number,
      record: SessionRecordSchema,
    },
    /** Human chat line (not part of the agent session log). */
    Chat: {
      id: S.String,
      from: ActorSchema,
      text: S.String,
      at: S.Number,
    },
  },
}) {}
