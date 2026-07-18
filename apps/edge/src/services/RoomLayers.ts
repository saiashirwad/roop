import { AgentRunner, AgentRunnerLive, type StreamToolkit } from "@roop/core/AgentRunner.ts"
import { SessionHub, SessionHubLive } from "@roop/core/SessionHub.ts"
import { SessionLog, SessionLogLive } from "@roop/core/SessionLog.ts"
import { SessionStore } from "@roop/core/SessionStore.ts"
import { Effect, Layer } from "effect"
import { DoState, Env } from "effect-workerd"

import type { Env as WorkerEnv } from "../env.ts"
import { FakeFsToolkit, fakeFsHandlers, FILES_SCHEMA, sqliteFileStorage } from "../fakefs.ts"
import { resolveRoomModel } from "../model.ts"
import { RoomActor } from "../RoomActor.ts"
import { makeRoomSessionStore, ROOM_SCHEMA } from "../sqlStore.ts"
import { makePromptQueue, PromptQueue } from "./PromptQueue.ts"

export type RoomServices = SessionStore | SessionLog | SessionHub | AgentRunner | PromptQueue

type RoomBundle = {
  /**
   * The DurableObjectState instance this bundle was built against.
   * Module-level Maps outlive hibernation; DO class instances do not.
   * Stale sql/storage handles throw:
   * "Cannot perform I/O on behalf of a different Durable Object".
   */
  readonly doState: DoState.DoState["Service"]
  readonly store: SessionStore["Service"]
  readonly log: SessionLog["Service"]
  readonly hub: SessionHub["Service"]
  readonly runner: AgentRunner["Service"]
  readonly queue: PromptQueue["Service"]
}

/**
 * ActorRuntime rebuilds `layer` on every message under a short scope.
 * Cache room services per DO id so the prompt pump, interrupt Deferred, and
 * SessionHub PubSub survive across invocations on the *same* DO instance.
 *
 * Invalidate when `DoState` identity changes (new DO constructor after
 * hibernation/recreate). Isolate stays warm but old storage I/O objects die.
 */
const roomBundles = new Map<string, RoomBundle>()

const buildBundle = (
  state: DoState.DoState["Service"],
  env: WorkerEnv,
): Effect.Effect<RoomBundle, never, RoomActor> =>
  Effect.gen(function* () {
    const sql = state.storage.sql
    const sessionId = state.id.toString()

    sql.exec(ROOM_SCHEMA)
    sql.exec(FILES_SCHEMA)

    const store = makeRoomSessionStore(sql, sessionId)
    const storeLive = Layer.succeed(SessionStore, store)
    const hubLive = SessionHubLive
    const logLive = SessionLogLive.pipe(Layer.provide(storeLive), Layer.provide(hubLive))
    const runnerLive = AgentRunnerLive.pipe(Layer.provide(logLive))
    const coreLive = Layer.mergeAll(storeLive, hubLive, logLive, runnerLive)

    const { log, runner, hub } = yield* Effect.gen(function* () {
      return {
        log: yield* SessionLog,
        runner: yield* AgentRunner,
        hub: yield* SessionHub,
      }
    }).pipe(Effect.provide(coreLive))

    yield* log.create({ kind: "main", title: "room" })

    const files = sqliteFileStorage(sql)
    const toolkitLayer = FakeFsToolkit.toLayer(Effect.succeed(fakeFsHandlers(files)))
    const toolkit = (yield* Effect.gen(function* () {
      return yield* FakeFsToolkit
    }).pipe(Effect.provide(toolkitLayer))) as unknown as StreamToolkit

    const model = yield* resolveRoomModel(env)

    // RoomActor is in the fiber (provideActor); fan-out captures the live client set.
    const queue = yield* makePromptQueue({ sessionId, model, toolkit }).pipe(
      Effect.provideService(SessionLog, log),
      Effect.provideService(AgentRunner, runner),
      Effect.provideService(SessionHub, hub),
      Effect.provideService(DoState.DoState, state),
    )

    return { doState: state, store, log, hub, runner, queue } satisfies RoomBundle
  })

/**
 * Durable room services for ActorRuntime `layer`.
 *
 * DoState/Env/RoomActor are available when the layer is built under provideActor +
 * ManagedRuntime; liminal's layer R type omits DoState so callers cast at the boundary.
 */
export const makeRoomLayers = (): Layer.Layer<
  RoomServices,
  never,
  DoState.DoState | Env | RoomActor
> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const state = yield* DoState.DoState
      const env = (yield* Env) as unknown as WorkerEnv
      const sessionId = state.id.toString()

      let bundle = roomBundles.get(sessionId)
      // Same id after hibernation is a new DO instance — do not reuse old sql.
      if (bundle === undefined || bundle.doState !== state) {
        bundle = yield* buildBundle(state, env)
        roomBundles.set(sessionId, bundle)
      }

      return Layer.mergeAll(
        Layer.succeed(SessionStore, bundle.store),
        Layer.succeed(SessionLog, bundle.log),
        Layer.succeed(SessionHub, bundle.hub),
        Layer.succeed(AgentRunner, bundle.runner),
        Layer.succeed(PromptQueue, bundle.queue),
      )
    }),
  )
