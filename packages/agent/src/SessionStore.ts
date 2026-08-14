import { Context, Effect, FileSystem, Layer, Ref, Schema } from "effect"
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

export const SessionMeta = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  updatedAt: Schema.Number,
})

export type SessionMeta = typeof SessionMeta.Type

const title = (messages: ReadonlyArray<Prompt.Message>) => {
  for (const message of messages) {
    if (message.role !== "user") continue
    for (const part of message.content) {
      if (part.type === "text") return part.text.length > 80 ? part.text.slice(0, 80) : part.text
    }
  }
  return ""
}

const metaOf = (session: Session): SessionMeta => ({
  id: session.id,
  title: title(session.messages),
  updatedAt: session.updatedAt,
})

const byRecency = (a: SessionMeta, b: SessionMeta) => b.updatedAt - a.updatedAt

export class SessionStore extends Context.Service<
  SessionStore,
  {
    readonly load: (sessionId: string) => Effect.Effect<Session, SessionNotFound>
    readonly save: (
      sessionId: string,
      messages: ReadonlyArray<Prompt.Message>,
    ) => Effect.Effect<Session>
    readonly list: () => Effect.Effect<ReadonlyArray<SessionMeta>>
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
      list: () =>
        Ref.get(sessions).pipe(Effect.map((map) => [...map.values()].map(metaOf).sort(byRecency))),
    })
  }),
)

export const SessionStoreFs = (
  dir: string,
): Layer.Layer<SessionStore, never, FileSystem.FileSystem> =>
  Layer.effect(
    SessionStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.orDie)
      const file = (sessionId: string) => `${dir}/${encodeURIComponent(sessionId)}.json`

      const read = (path: string) =>
        fs
          .readFileString(path)
          .pipe(Effect.flatMap((json) => Schema.decodeEffect(Schema.fromJsonString(Session))(json)))

      return SessionStore.of({
        load: (sessionId) =>
          read(file(sessionId)).pipe(Effect.mapError(() => new SessionNotFound({ sessionId }))),
        save: (sessionId, messages) =>
          Effect.gen(function* () {
            const session: Session = {
              id: sessionId,
              messages: [...messages],
              updatedAt: Date.now(),
            }
            const json = yield* Schema.encodeEffect(Schema.fromJsonString(Session))(session)
            yield* fs.writeFileString(file(sessionId), json)
            return session
          }).pipe(Effect.orDie),
        list: () =>
          fs.readDirectory(dir).pipe(
            Effect.flatMap((entries) =>
              Effect.forEach(
                entries.filter((entry) => entry.endsWith(".json")),
                (entry) => Effect.option(read(`${dir}/${entry}`)),
              ),
            ),
            Effect.map((sessions) =>
              sessions
                .flatMap((session) => (session._tag === "Some" ? [metaOf(session.value)] : []))
                .sort(byRecency),
            ),
            Effect.orDie,
          ),
      })
    }),
  )
