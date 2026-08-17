import { Crypto, Effect, Schema } from "effect"

const branded = <const Name extends string>(name: Name) => Schema.String.pipe(Schema.brand(name))

const EventIdSchema = branded("roop/EventId")
export const EventId = Object.assign(EventIdSchema, {
  is: Schema.is(EventIdSchema),
  generate: Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    return EventIdSchema.make(yield* Effect.orDie(crypto.randomUUIDv4))
  }),
})
export type EventId = typeof EventId.Type
export const isEventId = <I>(input: I): input is I & EventId => EventId.is(input)
export const makeEventId = (id: string): EventId => EventId.make(id)
export const generateEventId: Effect.Effect<EventId, never, Crypto.Crypto> = Effect.gen(
  function* () {
    const crypto = yield* Crypto.Crypto
    return makeEventId(yield* Effect.orDie(crypto.randomUUIDv4))
  },
)

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

const RunIdSchema = branded("roop/RunId")
export const RunId = Object.assign(RunIdSchema, {
  is: Schema.is(RunIdSchema),
  generate: Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    return RunIdSchema.make(yield* Effect.orDie(crypto.randomUUIDv4))
  }),
})
export type RunId = typeof RunId.Type
export const isRunId = <I>(input: I): input is I & RunId => RunId.is(input)
export const makeRunId = (id: string): RunId => RunId.make(id)
export const generateRunId: Effect.Effect<RunId, never, Crypto.Crypto> = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto
  return makeRunId(yield* Effect.orDie(crypto.randomUUIDv4))
})

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

const ToolCallIdSchema = branded("roop/ToolCallId")
export const ToolCallId = Object.assign(ToolCallIdSchema, {
  is: Schema.is(ToolCallIdSchema),
  generate: Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto
    return ToolCallIdSchema.make(yield* Effect.orDie(crypto.randomUUIDv4))
  }),
})
export type ToolCallId = typeof ToolCallId.Type
export const isToolCallId = <I>(input: I): input is I & ToolCallId => ToolCallId.is(input)
export const makeToolCallId = (id: string): ToolCallId => ToolCallId.make(id)
export const generateToolCallId: Effect.Effect<ToolCallId, never, Crypto.Crypto> = Effect.gen(
  function* () {
    const crypto = yield* Crypto.Crypto
    return makeToolCallId(yield* Effect.orDie(crypto.randomUUIDv4))
  },
)
