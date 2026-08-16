import { Crypto, Effect, Schema } from "effect"

export const ToolCallId = Schema.String.pipe(Schema.brand("roop/ToolCallId"))

export type ToolCallId = typeof ToolCallId.Type

export const is = Schema.is(ToolCallId)

export const make = (id: string): ToolCallId => ToolCallId.make(id)

export const generate: Effect.Effect<ToolCallId, never, Crypto.Crypto> = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto
  const uuid = yield* Effect.orDie(crypto.randomUUIDv4)
  return make(uuid)
})
