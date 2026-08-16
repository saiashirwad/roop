import { Crypto, Effect, Schema } from "effect"

export const SessionId = Schema.String.pipe(Schema.brand("roop/SessionId"))

export type SessionId = typeof SessionId.Type

export const is = Schema.is(SessionId)

export const make = (id: string): SessionId => SessionId.make(id)

export const generate: Effect.Effect<SessionId, never, Crypto.Crypto> = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto
  const uuid = yield* Effect.orDie(crypto.randomUUIDv4)
  return make(uuid)
})
