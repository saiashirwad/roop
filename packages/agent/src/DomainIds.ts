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
export const isSessionId = <I>(input: I): input is I & SessionId => SessionId.is(input)
export const makeSessionId = (id: string): SessionId => SessionId.make(id)
export const generateSessionId = Effect.fn("DomainIds.generateSessionId")(function* () {
  const crypto = yield* Crypto.Crypto
  return makeSessionId(yield* Effect.orDie(crypto.randomUUIDv4))
})

const RunIdSchema = branded("roop/RunId")
export const RunId = Object.assign(RunIdSchema, {
  is: Schema.is(RunIdSchema),
  generate: Effect.fn("DomainIds.RunId.generate")(function* () {
    const crypto = yield* Crypto.Crypto
    return RunIdSchema.make(yield* Effect.orDie(crypto.randomUUIDv4))
  }),
})
export type RunId = typeof RunId.Type
export const isRunId = <I>(input: I): input is I & RunId => RunId.is(input)
export const makeRunId = (id: string): RunId => RunId.make(id)
export const generateRunId = Effect.fn("DomainIds.generateRunId")(function* () {
  const crypto = yield* Crypto.Crypto
  return makeRunId(yield* Effect.orDie(crypto.randomUUIDv4))
})
