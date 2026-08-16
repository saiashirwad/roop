import { Crypto, Effect, Schema } from "effect"

export const RunId = Schema.String.pipe(Schema.brand("roop/RunId"))

export type RunId = typeof RunId.Type

export const is = Schema.is(RunId)

export const make = (id: string): RunId => RunId.make(id)

export const generate: Effect.Effect<RunId, never, Crypto.Crypto> = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto
  const uuid = yield* Effect.orDie(crypto.randomUUIDv4)
  return make(uuid)
})
