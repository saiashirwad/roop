import { Context, Effect, Layer, Ref, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"

export class SessionNotFound extends Schema.TaggedErrorClass<SessionNotFound>()("SessionNotFound", {
  sessionId: Schema.String,
}) {}

export const Session = Schema.Struct({
  id: Schema.String,
  messages: Schema.Array(Prompt.Message),
  updatedAt: Schema.Number,
})

export type Session = typeof Session.Type

export class SessionStore extends Context.Service<
  SessionStore,
  {
    readonly load: (sessionId: string) => Effect.Effect<Session, SessionNotFound>
    readonly save: (
      sessionId: string,
      messages: ReadonlyArray<Prompt.Message>,
    ) => Effect.Effect<Session>
  }
>()("roop/SessionStore") {}

export const SessionStoreMemory = Layer.effect(
  SessionStore,
  Effect.gen(function* () {
    const sessions = yield* Ref.make(new Map<string, Session>())

    return SessionStore.of({
      load: (sessionId) =>
        Ref.get(sessions).pipe(
          Effect.flatMap((map) => {
            const session = map.get(sessionId)
            return session === undefined
              ? Effect.fail(new SessionNotFound({ sessionId }))
              : Effect.succeed(session)
          }),
        ),
      save: (sessionId, messages) => {
        const session: Session = { id: sessionId, messages: [...messages], updatedAt: Date.now() }
        return Effect.as(
          Ref.update(sessions, (map) => new Map(map).set(sessionId, session)),
          session,
        )
      },
    })
  }),
)
