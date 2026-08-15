import { Clock, Console, Context, Crypto, Effect, FileSystem, Layer, Ref, Schema } from "effect"
import { Prompt } from "effect/unstable/ai"

import {
  deriveMessages,
  SESSION_FORMAT_VERSION,
  SessionEvent,
  SessionHeader,
} from "./SessionEvent.ts"

export class SessionNotFound extends Schema.TaggedErrorClass<SessionNotFound>()("SessionNotFound", {
  sessionId: Schema.String,
}) {}

export class SessionFormatError extends Schema.TaggedErrorClass<SessionFormatError>()(
  "SessionFormatError",
  {
    sessionId: Schema.String,
    message: Schema.String,
  },
) {}

export const Session = Schema.Struct({
  id: Schema.String,
  header: SessionHeader,
  events: Schema.Array(SessionEvent),
  updatedAt: Schema.Finite,
})

export type Session = typeof Session.Type

export const SessionMeta = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  updatedAt: Schema.Finite,
})

export type SessionMeta = typeof SessionMeta.Type

export type SessionLoadError = SessionNotFound | SessionFormatError

const title = (events: ReadonlyArray<SessionEvent>): string => {
  for (const event of events) {
    if (event._tag !== "user/message") continue
    return event.content.length > 80 ? event.content.slice(0, 80) : event.content
  }
  return ""
}

const metaOf = (session: Session): SessionMeta => ({
  id: session.id,
  title: title(session.events),
  updatedAt: session.updatedAt,
})

const byRecency = (a: SessionMeta, b: SessionMeta) => b.updatedAt - a.updatedAt

const newSession = (sessionId: string, now: number): Session => ({
  id: sessionId,
  header: { version: SESSION_FORMAT_VERSION, createdAt: now },
  events: [],
  updatedAt: now,
})

/** Decode a serialized session and reject anything this reader cannot trust. */
const decodeSession = (
  sessionId: string,
  json: string,
): Effect.Effect<Session, SessionFormatError> =>
  Schema.decodeEffect(Schema.fromJsonString(Session))(json).pipe(
    Effect.mapError(
      (error) =>
        new SessionFormatError({
          sessionId,
          message: String(error),
        }),
    ),
    Effect.flatMap((session) => {
      if (session.header.version > SESSION_FORMAT_VERSION) {
        return Effect.fail(
          new SessionFormatError({
            sessionId,
            message: `session log version ${session.header.version} is newer than supported version ${SESSION_FORMAT_VERSION}`,
          }),
        )
      }
      return Effect.succeed(session)
    }),
  )

export class SessionStore extends Context.Service<
  SessionStore,
  {
    readonly append: (sessionId: string, event: SessionEvent) => Effect.Effect<void>
    readonly deriveMessages: (
      sessionId: string,
    ) => Effect.Effect<ReadonlyArray<Prompt.Message>, SessionLoadError>
    readonly load: (sessionId: string) => Effect.Effect<Session, SessionLoadError>
    readonly list: Effect.Effect<ReadonlyArray<SessionMeta>>
  }
>()("roop/SessionStore") {}

export const SessionStoreMemory = Layer.effect(
  SessionStore,
  Effect.gen(function* () {
    const sessions = yield* Ref.make(new Map<string, Session>())

    return SessionStore.of({
      append: (sessionId, event) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          yield* Ref.update(sessions, (map) => {
            const session = map.get(sessionId) ?? newSession(sessionId, now)
            const next = new Map(map).set(sessionId, {
              ...session,
              events: [...session.events, event],
              updatedAt: now,
            })
            return next
          })
        }).pipe(Effect.asVoid),
      deriveMessages: (sessionId) =>
        Ref.get(sessions).pipe(
          Effect.flatMap((map) => {
            const session = map.get(sessionId)
            return session === undefined
              ? Effect.fail(new SessionNotFound({ sessionId }))
              : Effect.succeed(deriveMessages(session.events))
          }),
        ),
      load: (sessionId) =>
        Ref.get(sessions).pipe(
          Effect.flatMap((map) => {
            const session = map.get(sessionId)
            return session === undefined
              ? Effect.fail(new SessionNotFound({ sessionId }))
              : Effect.succeed(session)
          }),
        ),
      list:
        Ref.get(sessions).pipe(Effect.map((map) => [...map.values()].map(metaOf).sort(byRecency))),
    })
  }),
)

export const SessionStoreFs = (
  dir: string,
): Layer.Layer<SessionStore, never, FileSystem.FileSystem | Crypto.Crypto> =>
  Layer.effect(
    SessionStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const crypto = yield* Crypto.Crypto
      yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.orDie)
      const file = (sessionId: string) => `${dir}/${encodeURIComponent(sessionId)}.json`

      // FileSystem.readFileString fails with a PlatformError whose `reason` is a
      // SystemError; every platform implementation normalizes ENOENT to the
      // reason tag "NotFound" (see effect's platform-node errno mapping). We
      // match structurally so this stays portable across platform adapters.
      const isFileNotFound = (error: unknown): boolean => {
        /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
        const reason = (error as { reason?: { _tag?: string } } | null)?.reason
        if (reason !== undefined && reason._tag !== undefined) {
          return reason._tag === "NotFound"
        }
        return error instanceof Error && error.message.includes("ENOENT")
      }

      const write = (session: Session) =>
        Effect.flatMap(crypto.randomUUIDv4, (suffix) => {
          const target = file(session.id)
          const tmp = `${target}.${suffix}.tmp`
          return Effect.gen(function* () {
            const json = yield* Schema.encodeEffect(Schema.fromJsonString(Session))(session)
            // write-then-rename: the tmp file lives beside the target so the
            // rename is atomic (same filesystem) and a crash mid-write never
            // truncates an existing log.
            yield* fs.writeFileString(tmp, json)
            yield* fs.rename(tmp, target)
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.asVoid(
                fs
                  .remove(tmp, { force: true })
                  .pipe(Effect.ignore, Effect.andThen(Effect.failCause(cause))),
              ),
            ),
            Effect.orDie,
          )
        }).pipe(Effect.orDie)

      const read = (sessionId: string): Effect.Effect<Session, SessionLoadError> =>
        fs.readFileString(file(sessionId)).pipe(
          Effect.catchTag("PlatformError", (error) =>
            isFileNotFound(error)
              ? Effect.fail(new SessionNotFound({ sessionId }))
              : Effect.die(error),
          ),
          Effect.flatMap((json) => decodeSession(sessionId, json)),
        )

      return SessionStore.of({
        append: (sessionId, event) =>
          Effect.gen(function* () {
            // Only a genuinely missing log starts a new session; a corrupt log
            // (SessionFormatError) or IO trouble dies rather than being
            // mistaken for "no such session" and silently resetting the log.
            const session = yield* read(sessionId).pipe(
              Effect.catchIf(
                (error): error is SessionNotFound => error._tag === "SessionNotFound",
                () => Effect.map(Clock.currentTimeMillis, (now) => newSession(sessionId, now)),
              ),
              Effect.orDie,
            )
            yield* write({
              ...session,
              // Appending v2 events upgrades a readable v1 log before writing;
              // otherwise its header would falsely describe the contents.
              header: { ...session.header, version: SESSION_FORMAT_VERSION },
              events: [...session.events, event],
              updatedAt: yield* Clock.currentTimeMillis,
            })
          }),
        deriveMessages: (sessionId) =>
          Effect.map(read(sessionId), (session) => deriveMessages(session.events)),
        load: read,
        list:
          fs.readDirectory(dir).pipe(
            Effect.flatMap((entries) =>
              Effect.forEach(
                entries.filter((entry) => entry.endsWith(".json")),
                (entry) => {
                  const sessionId = decodeURIComponent(entry.replace(/\.json$/, ""))
                  return read(sessionId).pipe(
                    // A missing file is normal (deleted mid-listing) and stays
                    // silent; anything else (e.g. a newer format version)
                    // deserves a warning before the session is skipped.
                    Effect.tapError((error) =>
                      error._tag === "SessionNotFound"
                        ? Effect.void
                        : Console.warn(
                            `skipping session ${sessionId} (${entry}): ${error._tag}: ${error.message ?? ""}`,
                          ),
                    ),
                    Effect.option,
                  )
                },
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
