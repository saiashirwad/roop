import * as ActorNamespace from "liminal/ActorNamespace"

import { RoomActor } from "./RoomActor.ts"

/** Wrangler binding `ROOM` → this namespace. */
export class RoomNamespace extends ActorNamespace.Service<RoomNamespace>()("RoomNamespace", {
  binding: "ROOM",
  actor: RoomActor,
  internal: {},
}) {}
