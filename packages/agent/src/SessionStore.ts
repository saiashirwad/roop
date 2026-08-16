import {
  Clock,
  Console,
  Context,
  Crypto,
  Effect,
  FileSystem,
  Layer,
  Option,
  PlatformError,
  Ref,
  Schema,
  Semaphore,
} from "effect"
import { Prompt } from "effect/unstable/ai"

import {
  deriveMessages,
  SESSION_FORMAT_VERSION,
  SessionEvent,
  SessionHeader,
} from "./SessionEvent.ts"
import { SessionId } from "./SessionId.ts"

export class SessionNotFound extends Schema.TaggedErrorClass<SessionNotFound>()("SessionNotFound", {
  sessionId: SessionId,
}) {}

export class SessionFormatError extends Schema.TaggedErrorClass<SessionFormatError>()(
  "SessionFormatError",
  {
    sessionId: SessionId,
    message: Schema.String,
  },
) {}

export class SessionAlreadyExists extends Schema.TaggedErrorClass<SessionAlreadyExists>()(
  "SessionAlreadyExists",
  { sessionId: SessionId },
) {}

export const Session = Schema.Struct({
  id: SessionId,
  header: SessionHeader,
  events: Schema.Array(SessionEvent),
  updatedAt: Schema.Finite,
})

export type Session = typeof Session.Type

export const SessionMeta = Schema.Struct({
  id: SessionId,
  title: Schema.String,
  updatedAt: Schema.Finite,
})

export type SessionMeta = typeof SessionMeta.Type

type SessionLoadError = SessionNotFound | SessionFormatError

const title = (events: ReadonlyArray<SessionEvent>): string => {
  for (const event of events) {
    if (event._tag !== "user/message") continue
    return event.content.length > 80 ? event.content.slice(0, 80) : event.content
  }
  return ""
}

const metaOf = (session: Session): SessionMeta => ({
  id: SessionId.make(session.id),
  title: title(session.events),
  updatedAt: session.updatedAt,
})

const byRecency = (a: SessionMeta, b: SessionMeta) => b.updatedAt - a.updatedAt

const newSession = (sessionId: string, now: number): Session => ({
  id: SessionId.make(sessionId),
  header: { version: SESSION_FORMAT_VERSION, createdAt: now },
  events: [],
  updatedAt: now,
})

type MemoryForkResult =
  | { readonly _tag: "missing" }
  | { readonly _tag: "exists" }
  | { readonly _tag: "ok"; readonly meta: SessionMeta }

/** Decode a serialized session and reject anything this reader cannot trust. */
const decodeSession = (
  sessionId: string,
  json: string,
): Effect.Effect<Session, SessionFormatError> =>
  Schema.decodeEffect(Schema.fromJsonString(Session))(json).pipe(
    Effect.mapError(
      (error) =>
        new SessionFormatError({
          sessionId: SessionId.make(sessionId),
          message: String(error),
        }),
    ),
    Effect.flatMap((session) => {
      if (session.id !== sessionId) {
        return Effect.fail(
          new SessionFormatError({
            sessionId: SessionId.make(sessionId),
            message: `session id ${JSON.stringify(session.id)} does not match requested id ${JSON.stringify(sessionId)}`,
          }),
        )
      }
      if (session.header.version > SESSION_FORMAT_VERSION) {
        return Effect.fail(
          new SessionFormatError({
            sessionId: SessionId.make(sessionId),
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
    readonly append: (sessionId: SessionId | string, event: SessionEvent) => Effect.Effect<void>
    readonly deriveMessages: (
      sessionId: SessionId | string,
    ) => Effect.Effect<ReadonlyArray<Prompt.Message>, SessionLoadError>
    readonly load: (sessionId: SessionId | string) => Effect.Effect<Session, SessionLoadError>
    readonly list: Effect.Effect<ReadonlyArray<SessionMeta>>
    readonly fork: (
      fromSessionId: SessionId | string,
      toSessionId: SessionId | string,
    ) => Effect.Effect<SessionMeta, SessionLoadError | SessionAlreadyExists>
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
              ? Effect.fail(new SessionNotFound({ sessionId: SessionId.make(sessionId) }))
              : Effect.succeed(deriveMessages(session.events))
          }),
        ),
      load: (sessionId) =>
        Ref.get(sessions).pipe(
          Effect.flatMap((map) => {
            const session = map.get(sessionId)
            return session === undefined
              ? Effect.fail(new SessionNotFound({ sessionId: SessionId.make(sessionId) }))
              : Effect.succeed(session)
          }),
        ),
      list: Ref.get(sessions).pipe(
        Effect.map((map) => [...map.values()].map(metaOf).sort(byRecency)),
      ),
      fork: (fromSessionId, toSessionId) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const result = yield* Ref.modify(
            sessions,
            (map): readonly [MemoryForkResult, Map<string, Session>] => {
              const source = map.get(fromSessionId)
              if (source === undefined) return [{ _tag: "missing" } as const, map]
              if (map.has(toSessionId)) return [{ _tag: "exists" } as const, map]
              const forked: Session = {
                id: SessionId.make(toSessionId),
                header: { version: SESSION_FORMAT_VERSION, createdAt: now },
                events: [...source.events],
                updatedAt: now,
              }
              return [
                { _tag: "ok", meta: metaOf(forked) } as const,
                new Map(map).set(toSessionId, forked),
              ]
            },
          )
          if (result._tag === "missing") {
            return yield* new SessionNotFound({ sessionId: SessionId.make(fromSessionId) })
          }
          if (result._tag === "exists") {
            return yield* new SessionAlreadyExists({ sessionId: SessionId.make(toSessionId) })
          }
          return result.meta
        }),
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
      // This lock is intentionally runtime-local. Writers in another runtime still
      // need an external transactional store or file locking primitive.
      const appendLocks = new Map<string, Semaphore.Semaphore>()
      const lockFor = (sessionId: string) => {
        const existing = appendLocks.get(sessionId)
        if (existing !== undefined) return existing
        const lock = Semaphore.makeUnsafe(1)
        appendLocks.set(sessionId, lock)
        return lock
      }
      yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.orDie)
      const file = (sessionId: string) => `${dir}/${encodeURIComponent(sessionId)}.json`

      // FileSystem.readFileString fails with a PlatformError whose `reason` is a
      // SystemError; every platform implementation normalizes ENOENT to the
      // reason tag "NotFound" (see effect's platform-node errno mapping).
      const isFileNotFound = (error: PlatformError.PlatformError): boolean =>
        error.reason._tag === "NotFound"

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
              ? Effect.fail(new SessionNotFound({ sessionId: SessionId.make(sessionId) }))
              : Effect.die(error),
          ),
          Effect.flatMap((json) => decodeSession(sessionId, json)),
        )

      const exists = (sessionId: string): Effect.Effect<boolean> =>
        fs.readFileString(file(sessionId)).pipe(
          Effect.map(() => true),
          Effect.catchTag("PlatformError", (error) =>
            isFileNotFound(error) ? Effect.succeed(false) : Effect.die(error),
          ),
        )

      return SessionStore.of({
        append: (sessionId, event) =>
          lockFor(sessionId).withPermit(
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
          ),
        deriveMessages: (sessionId) =>
          Effect.map(read(sessionId), (session) => deriveMessages(session.events)),
        load: read,
        list: fs.readDirectory(dir).pipe(
          Effect.flatMap((entries) =>
            Effect.forEach(
              entries.filter((entry) => entry.endsWith(".json")),
              (entry) => {
                let sessionId: string
                try {
                  sessionId = decodeURIComponent(entry.replace(/\.json$/, ""))
                } catch {
                  return Effect.succeed(Option.none<Session>())
                }
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
        fork: (fromSessionId, toSessionId) =>
          lockFor(toSessionId).withPermit(
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis
              const source = yield* read(fromSessionId)
              if (yield* exists(toSessionId)) {
                return yield* new SessionAlreadyExists({ sessionId: SessionId.make(toSessionId) })
              }
              const forked: Session = {
                id: SessionId.make(toSessionId),
                header: { version: SESSION_FORMAT_VERSION, createdAt: now },
                events: [...source.events],
                updatedAt: now,
              }
              yield* write(forked)
              return metaOf(forked)
            }),
          ),
      })
    }),
  )
