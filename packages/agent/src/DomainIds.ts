import { Crypto, Effect, Schema } from "effect"

const branded = <const Name extends string>(name: Name) => Schema.String.pipe(Schema.brand(name))

const SessionIdSchema = branded("roop/SessionId")
export const SessionId = Object.assign(SessionIdSchema, {
  is: Schema.is(SessionIdSchema),
  generate: Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    return SessionIdSchema.make(yield* Effect.orDie(crypto.randomUUIDv4))
  }),
})
export type SessionId = typeof SessionId.Type
export const isSessionId = <I>(input: I): input is I & SessionId => SessionId.is(input)
export const makeSessionId = (id: string): SessionId => SessionId.make(id)
export const generateSessionId: Effect.Effect<SessionId, never, Crypto.Crypto> = Effect.gen(
  function* () {
    const crypto = yield* Crypto.Crypto
    return makeSessionId(yield* Effect.orDie(crypto.randomUUIDv4))
  },
)
