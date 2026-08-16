import { Crypto, Effect, Schema } from "effect"

export const EventId = Schema.String.pipe(Schema.brand("roop/EventId"))

export type EventId = typeof EventId.Type

export const is = Schema.is(EventId)

export const make = (id: string): EventId => EventId.make(id)

export const generate: Effect.Effect<EventId, never, Crypto.Crypto> = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto
  const uuid = yield* Effect.orDie(crypto.randomUUIDv4)
  return make(uuid)
})
