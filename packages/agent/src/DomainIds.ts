import { Crypto, Effect, Schema } from "effect"

const branded = <const Name extends string>(name: Name) => Schema.String.pipe(Schema.brand(name))

const ModelIdSchema = branded("roop/ModelId")
export const ModelId = Object.assign(ModelIdSchema, {
  is: Schema.is(ModelIdSchema),
})
export type ModelId = typeof ModelId.Type
export const isModelId = <I>(input: I): input is I & ModelId => ModelId.is(input)
export const makeModelId = (id: string): ModelId => ModelId.make(id)

const PluginIdSchema = branded("roop/PluginId")
export const PluginId = Object.assign(PluginIdSchema, {
  is: Schema.is(PluginIdSchema),
})
export type PluginId = typeof PluginId.Type
export const isPluginId = <I>(input: I): input is I & PluginId => PluginId.is(input)
export const makePluginId = (id: string): PluginId => PluginId.make(id)

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
