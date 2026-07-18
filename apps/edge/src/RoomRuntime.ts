import { Layer } from "effect"
import type { HttpClient } from "effect/unstable/http"
import * as ActorRuntime from "liminal/ActorRuntime"
import type { Env } from "effect-workerd"

import Interrupt from "./handleInterrupt.ts"
import Prompt from "./handlePrompt.ts"
import Say from "./handleSay.ts"
import hydrate from "./hydrate.ts"
import onDisconnect from "./onDisconnect.ts"
import { RoomActor } from "./RoomActor.ts"
import { RoomNamespace } from "./RoomNamespace.ts"
import { makeRoomLayers, type RoomServices } from "./services/RoomLayers.ts"

/**
 * Multiplayer room as a liminal ActorRuntime.
 *
 * Hibernation-safe: durable state lives in DO sql; in-memory layers rebuild on wake
 * (with isolate-level cache while warm). Exported as `Room` from main.ts so wrangler
 * `class_name = "Room"` stays stable.
 *
 * Liminal types omit DoState from layer R even though ManagedRuntime provides it;
 * cast keeps RunROut = RoomServices for handlers/hydrate.
 */
export class RoomRuntime extends ActorRuntime.make({
  namespace: RoomNamespace,
  prelude: Layer.empty,
  hydrate,
  onDisconnect,
  external: { Prompt, Interrupt, Say },
  layer: makeRoomLayers() as unknown as Layer.Layer<
    RoomServices,
    never,
    RoomActor | HttpClient.HttpClient | Env
  >,
  hibernation: "5 seconds",
  internal: {},
}) {}
