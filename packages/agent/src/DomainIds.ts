import { Crypto, Effect, Schema } from "effect"

const branded = <const Name extends string>(name: Name) => Schema.String.pipe(Schema.brand(name))

const SessionIdSchema = branded("roop/SessionId")
export const SessionId = Object.assign(SessionIdSchema, {
  is: Schema.is(SessionIdSchema),
  generate: Effect.fn("DomainIds.SessionId.generate")(function* () {
    const crypto = yield* Crypto.Crypto
    return SessionIdSchema.make(yield* Effect.orDie(crypto.randomUUIDv4))
  }),
})
export type SessionId = typeof SessionId.Type

const RunIdSchema = branded("roop/RunId")
export const RunId = Object.assign(RunIdSchema, {
  is: Schema.is(RunIdSchema),
  generate: Effect.fn("DomainIds.RunId.generate")(function* () {
    const crypto = yield* Crypto.Crypto
    return RunIdSchema.make(yield* Effect.orDie(crypto.randomUUIDv4))
  }),
})
export type RunId = typeof RunId.Type
