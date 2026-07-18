import * as NodeSocket from "@effect/platform-node/NodeSocket"
import type { SessionRecord } from "@roop/core/SessionStore.ts"
import * as reducers from "@roop/edge/reducers"
import { RoomClient } from "@roop/edge/RoomClient"
import { Cause, Effect, Fiber, Layer, ManagedRuntime, Stream } from "effect"
import * as Client from "liminal/Client"

export type Member = { id: string; name: string }

export type ChatMessage = {
  readonly id: string
  readonly from: Member
  readonly text: string
  readonly at: number
}

export type ConnectionHandlers = {
  readonly onJoin: (info: {
    self: Member
    members: ReadonlyArray<Member>
    running: boolean
  }) => void
  readonly onPresence: (members: ReadonlyArray<Member>) => void
  readonly onRecord: (seq: number, record: SessionRecord) => void
  readonly onChat: (message: ChatMessage) => void
  readonly onError: (message: string) => void
  readonly onStatus: (message: string) => void
}

export type RoomConnection = {
  readonly prompt: (text: string) => Promise<void>
  readonly say: (text: string) => Promise<void>
  readonly interrupt: () => Promise<void>
  readonly dispose: () => Promise<void>
}

const makeLayer = (url: string, handlers: ConnectionHandlers) =>
  Client.layerSocket({
    client: RoomClient,
    url,
    replay: { mode: "startup" },
    reducers,
    onConnect: (state) =>
      Effect.sync(() => {
        handlers.onJoin({
          self: state.self,
          members: state.members,
          running: state.running,
        })
      }),
  }).pipe(Layer.provide(NodeSocket.layerWebSocketConstructor))

/**
 * Solid owns UI state; this module owns the Effect/liminal socket.
 * Handlers are called from the Effect runtime — keep them thin and sync.
 */
export const connectRoom = (
  roomUrl: string,
  displayName: string,
  handlers: ConnectionHandlers,
): RoomConnection => {
  let lastSeq = 0
  const base = roomUrl.replace(/^http/, "ws")
  const withName = `${base}${base.includes("?") ? "&" : "?"}name=${encodeURIComponent(displayName)}`

  type Services = RoomClient
  let runtime: ManagedRuntime.ManagedRuntime<Services, never> | undefined
  let eventsFiber: Fiber.Fiber<void, unknown> | undefined

  const url = () => `${withName}&after=${lastSeq}`

  const start = async () => {
    const layer = makeLayer(url(), {
      ...handlers,
      onRecord: (seq, record) => {
        if (seq > lastSeq) lastSeq = seq
        handlers.onRecord(seq, record)
      },
    })
    runtime = ManagedRuntime.make(layer)

    const listen = RoomClient.events.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          if (event._tag === "Presence") {
            handlers.onPresence(event.members)
            return
          }
          if (event._tag === "Record") {
            if (event.seq > lastSeq) lastSeq = event.seq
            handlers.onRecord(event.seq, event.record)
            return
          }
          if (event._tag === "Chat") {
            handlers.onChat({
              id: event.id,
              from: event.from,
              text: event.text,
              at: event.at,
            })
          }
        }),
      ),
    )

    eventsFiber = runtime.runFork(listen)

    // Force connect via first state pull.
    await runtime.runPromise(RoomClient.state.pipe(Stream.take(1), Stream.runDrain, Effect.ignore))
  }

  const ensure = start()

  return {
    prompt: async (text) => {
      await ensure
      if (runtime === undefined) return
      await runtime.runPromise(
        RoomClient.fn("Prompt")({ text }).pipe(
          Effect.catchCause((cause) => Effect.sync(() => handlers.onError(Cause.pretty(cause)))),
        ),
      )
    },
    say: async (text) => {
      await ensure
      if (runtime === undefined) return
      await runtime.runPromise(
        RoomClient.fn("Say")({ text }).pipe(
          Effect.catchCause((cause) => Effect.sync(() => handlers.onError(Cause.pretty(cause)))),
        ),
      )
    },
    interrupt: async () => {
      await ensure
      if (runtime === undefined) return
      await runtime.runPromise(RoomClient.fn("Interrupt")({}).pipe(Effect.ignore))
    },
    dispose: async () => {
      await ensure
      if (eventsFiber !== undefined) {
        await runtime?.runPromise(Fiber.interrupt(eventsFiber).pipe(Effect.ignore))
      }
      await runtime?.dispose()
      runtime = undefined
    },
  }
}
