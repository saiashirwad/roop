import {
  Clock,
  Console,
  Context,
  Crypto,
  Effect,
  FileSystem,
  Layer,
  Option,
  type PlatformError,
  Ref,
  Schema,
  Semaphore,
} from "effect"
import type { Prompt } from "effect/unstable/ai"
/**
 * @deprecated Internal compatibility facade for the pre-U4 session API.
 * New kernel code must use Journal and JournalMemory. Filesystem storage,
 * listing, forking, and title projection are not part of the Journal contract.
 * The experimental release does not migrate or load old filesystem sessions;
 * commit 83e4cc7 is the recovery/export reference.
 */

import {
  deriveMessages,
  SESSION_FORMAT_VERSION,
  SessionEvent,
  SessionHeader,
} from "./AgentEvents.ts"
import { SessionId } from "./DomainIds.ts"

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

export class SessionIoError extends Schema.TaggedErrorClass<SessionIoError>()("SessionIoError", {
  operation: Schema.String,
  sessionId: Schema.optionalKey(SessionId),
  message: Schema.String,
}) {}

export class SessionConflict extends Schema.TaggedErrorClass<SessionConflict>()("SessionConflict", {
  sessionId: SessionId,
  expectedRevision: Schema.Finite,
  actualRevision: Schema.Finite,
}) {}

export const Session = Schema.Struct({
  id: SessionId,
  header: SessionHeader,
  events: Schema.Array(SessionEvent),
  updatedAt: Schema.Finite,
  revision: Schema.Finite,
})

export type Session = typeof Session.Type

export const SessionMeta = Schema.Struct({
  id: SessionId,
  title: Schema.String,
  updatedAt: Schema.Finite,
  revision: Schema.Finite,
})

export type SessionMeta = typeof SessionMeta.Type

export type SessionLoadError = SessionNotFound | SessionFormatError | SessionIoError
export type SessionAppendError =
  | SessionNotFound
  | SessionFormatError
  | SessionIoError
  | SessionConflict
export type SessionForkError =
  | SessionNotFound
  | SessionFormatError
  | SessionAlreadyExists
  | SessionIoError

export interface AppendOptions {
  readonly expectedRevision?: number | undefined
}

const title = (events: ReadonlyArray<SessionEvent>): string => {
  for (const event of events) {
    if (event._tag !== "user/message") continue
    return event.content.length > 80 ? event.content.slice(0, 80) : event.content
  }
  return ""
}

export const metaOf = (session: Session): SessionMeta => ({
  id: SessionId.make(session.id),
  title: title(session.events),
  updatedAt: session.updatedAt,
  revision: session.revision,
})

const byRecency = (a: SessionMeta, b: SessionMeta) => b.updatedAt - a.updatedAt

type MemoryAppendResult =
  | { readonly _tag: "conflict"; readonly actualRevision: number }
  | { readonly _tag: "ok"; readonly revision: number }

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

export class SessionJournal extends Context.Service<
  SessionJournal,
  {
    readonly append: (
      sessionId: SessionId | string,
      event: SessionEvent,
      options?: AppendOptions,
    ) => Effect.Effect<void, SessionAppendError>
    readonly appendBatch: (
      sessionId: SessionId | string,
      events: ReadonlyArray<SessionEvent>,
      options?: AppendOptions,
    ) => Effect.Effect<number, SessionAppendError>
    readonly deriveMessages: (
      sessionId: SessionId | string,
    ) => Effect.Effect<ReadonlyArray<Prompt.Message>, SessionLoadError>
    readonly load: (sessionId: SessionId | string) => Effect.Effect<Session, SessionLoadError>
    readonly list: Effect.Effect<ReadonlyArray<SessionMeta>, SessionIoError>
    readonly fork: (
      fromSessionId: SessionId | string,
      toSessionId: SessionId | string,
    ) => Effect.Effect<SessionMeta, SessionForkError>
  }
>()("roop/SessionJournal") {}

export const SessionJournalMemory = Layer.effect(
  SessionJournal,
  Effect.gen(function* () {
    const sessions = yield* Ref.make(new Map<string, Session>())

    return SessionJournal.of({
      append: (sessionId, event, options) =>
        Effect.asVoid(
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis
            const result = yield* Ref.modify(
              sessions,
              (map): readonly [MemoryAppendResult, Map<string, Session>] => {
                const existing = map.get(sessionId)
                if (existing === undefined) {
                  if (options?.expectedRevision !== undefined && options.expectedRevision !== 0) {
                    return [{ _tag: "conflict", actualRevision: 0 } as const, map]
                  }
                  const session: Session = {
                    id: SessionId.make(sessionId),
                    header: { version: SESSION_FORMAT_VERSION, createdAt: now },
                    events: [event],
                    updatedAt: now,
                    revision: 1,
                  }
                  return [
                    { _tag: "ok", revision: 1 } as const,
                    new Map(map).set(sessionId, session),
                  ]
                }
                const currentRevision = existing.revision
                if (
                  options?.expectedRevision !== undefined &&
                  options.expectedRevision !== currentRevision
                ) {
                  return [{ _tag: "conflict", actualRevision: currentRevision } as const, map]
                }
                const nextRevision = currentRevision + 1
                const updated: Session = {
                  ...existing,
                  events: [...existing.events, event],
                  updatedAt: now,
                  revision: nextRevision,
                }
                return [
                  { _tag: "ok", revision: nextRevision } as const,
                  new Map(map).set(sessionId, updated),
                ]
              },
            )
            if (result._tag === "conflict") {
              return yield* new SessionConflict({
                sessionId: SessionId.make(sessionId),
                expectedRevision: options?.expectedRevision ?? 0,
                actualRevision: result.actualRevision,
              })
            }
            return result.revision
          }),
        ),
      appendBatch: (sessionId, events, options) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const result = yield* Ref.modify(
            sessions,
            (map): readonly [MemoryAppendResult, Map<string, Session>] => {
              const existing = map.get(sessionId)
              if (existing === undefined) {
                if (options?.expectedRevision !== undefined && options.expectedRevision !== 0) {
                  return [{ _tag: "conflict", actualRevision: 0 } as const, map]
                }
                const session: Session = {
                  id: SessionId.make(sessionId),
                  header: { version: SESSION_FORMAT_VERSION, createdAt: now },
                  events: [...events],
                  updatedAt: now,
                  revision: events.length,
                }
                return [
                  { _tag: "ok", revision: session.revision } as const,
                  new Map(map).set(sessionId, session),
                ]
              }
              const currentRevision = existing.revision
              if (
                options?.expectedRevision !== undefined &&
                options.expectedRevision !== currentRevision
              ) {
                return [{ _tag: "conflict", actualRevision: currentRevision } as const, map]
              }
              const nextRevision = currentRevision + events.length
              const updated: Session = {
                ...existing,
                events: [...existing.events, ...events],
                updatedAt: now,
                revision: nextRevision,
              }
              return [
                { _tag: "ok", revision: nextRevision } as const,
                new Map(map).set(sessionId, updated),
              ]
            },
          )
          if (result._tag === "conflict") {
            return yield* new SessionConflict({
              sessionId: SessionId.make(sessionId),
              expectedRevision: options?.expectedRevision ?? 0,
              actualRevision: result.actualRevision,
            })
          }
          return result.revision
        }),
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
                revision: source.revision,
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

export const SessionJournalFs = (
  dir: string,
): Layer.Layer<SessionJournal, never, FileSystem.FileSystem | Crypto.Crypto> =>
  Layer.effect(
    SessionJournal,
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
      const file = (sessionId: string) => `${dir}/${encodeURIComponent(sessionId)}.json`

      const isFileNotFound = (error: PlatformError.PlatformError): boolean =>
        error.reason._tag === "NotFound"

      const write = (
        session: Session,
      ): Effect.Effect<void, SessionIoError | SessionFormatError> => {
        const sid = session.id
        return crypto.randomUUIDv4.pipe(
          Effect.mapError(
            (error) =>
              new SessionIoError({
                operation: "write",
                sessionId: sid,
                message: String(error),
              }),
          ),
          Effect.flatMap((suffix) => {
            const target = file(sid)
            const tmp = `${target}.${suffix}.tmp`
            return Effect.gen(function* () {
              const json = yield* Schema.encodeEffect(Schema.fromJsonString(Session))(session).pipe(
                Effect.mapError(
                  (error) =>
                    new SessionFormatError({
                      sessionId: sid,
                      message: String(error),
                    }),
                ),
              )
              yield* fs.makeDirectory(dir, { recursive: true }).pipe(
                Effect.mapError(
                  (error) =>
                    new SessionIoError({
                      operation: "write",
                      sessionId: sid,
                      message: String(error),
                    }),
                ),
              )
              yield* fs.writeFileString(tmp, json).pipe(
                Effect.mapError(
                  (error) =>
                    new SessionIoError({
                      operation: "write",
                      sessionId: sid,
                      message: String(error),
                    }),
                ),
              )
              yield* fs.rename(tmp, target).pipe(
                Effect.mapError(
                  (error) =>
                    new SessionIoError({
                      operation: "write",
                      sessionId: sid,
                      message: String(error),
                    }),
                ),
              )
            }).pipe(
              Effect.catchCause((cause) =>
                fs
                  .remove(tmp, { force: true })
                  .pipe(Effect.ignore, Effect.andThen(Effect.failCause(cause))),
              ),
            )
          }),
        )
      }

      const read = (sessionId: string): Effect.Effect<Session, SessionLoadError> =>
        fs.readFileString(file(sessionId)).pipe(
          Effect.mapError((error) =>
            isFileNotFound(error)
              ? new SessionNotFound({ sessionId: SessionId.make(sessionId) })
              : new SessionIoError({
                  operation: "read",
                  sessionId: SessionId.make(sessionId),
                  message: String(error),
                }),
          ),
          Effect.flatMap((json) => decodeSession(sessionId, json)),
        )

      const exists = (sessionId: string): Effect.Effect<boolean, SessionIoError> =>
        fs.readFileString(file(sessionId)).pipe(
          Effect.as(true),
          Effect.catchIf(isFileNotFound, () => Effect.succeed(false)),
          Effect.mapError(
            (error) =>
              new SessionIoError({
                operation: "exists",
                sessionId: SessionId.make(sessionId),
                message: String(error),
              }),
          ),
        )

      return SessionJournal.of({
        append: (sessionId, event, options) =>
          lockFor(sessionId).withPermit(
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis
              const existing = yield* read(sessionId).pipe(
                Effect.map(Option.some),
                Effect.catchIf(
                  (error): error is SessionNotFound => error._tag === "SessionNotFound",
                  () => Effect.succeed(Option.none<Session>()),
                ),
              )
              if (Option.isNone(existing)) {
                if (options?.expectedRevision !== undefined && options.expectedRevision !== 0) {
                  return yield* new SessionConflict({
                    sessionId: SessionId.make(sessionId),
                    expectedRevision: options.expectedRevision,
                    actualRevision: 0,
                  })
                }
                const session: Session = {
                  id: SessionId.make(sessionId),
                  header: { version: SESSION_FORMAT_VERSION, createdAt: now },
                  events: [event],
                  updatedAt: now,
                  revision: 1,
                }
                yield* write(session)
                return
              }
              const session = existing.value
              const currentRevision = session.revision
              if (
                options?.expectedRevision !== undefined &&
                options.expectedRevision !== currentRevision
              ) {
                return yield* new SessionConflict({
                  sessionId: SessionId.make(sessionId),
                  expectedRevision: options.expectedRevision,
                  actualRevision: currentRevision,
                })
              }
              const nextRevision = currentRevision + 1
              yield* write({
                ...session,
                header: { ...session.header, version: SESSION_FORMAT_VERSION },
                events: [...session.events, event],
                updatedAt: now,
                revision: nextRevision,
              })
            }),
          ),
        appendBatch: (sessionId, events, options) =>
          lockFor(sessionId).withPermit(
            Effect.gen(function* () {
              const now = yield* Clock.currentTimeMillis
              const existing = yield* read(sessionId).pipe(
                Effect.map(Option.some),
                Effect.catchIf(
                  (error): error is SessionNotFound => error._tag === "SessionNotFound",
                  () => Effect.succeed(Option.none<Session>()),
                ),
              )
              if (Option.isNone(existing)) {
                if (options?.expectedRevision !== undefined && options.expectedRevision !== 0) {
                  return yield* new SessionConflict({
                    sessionId: SessionId.make(sessionId),
                    expectedRevision: options.expectedRevision,
                    actualRevision: 0,
                  })
                }
                const session: Session = {
                  id: SessionId.make(sessionId),
                  header: { version: SESSION_FORMAT_VERSION, createdAt: now },
                  events: [...events],
                  updatedAt: now,
                  revision: events.length,
                }
                yield* write(session)
                return session.revision
              }
              const session = existing.value
              const currentRevision = session.revision
              if (
                options?.expectedRevision !== undefined &&
                options.expectedRevision !== currentRevision
              ) {
                return yield* new SessionConflict({
                  sessionId: SessionId.make(sessionId),
                  expectedRevision: options.expectedRevision,
                  actualRevision: currentRevision,
                })
              }
              const nextRevision = currentRevision + events.length
              yield* write({
                ...session,
                header: { ...session.header, version: SESSION_FORMAT_VERSION },
                events: [...session.events, ...events],
                updatedAt: now,
                revision: nextRevision,
              })
              return nextRevision
            }),
          ),
        deriveMessages: (sessionId) =>
          Effect.map(read(sessionId), (session) => deriveMessages(session.events)),
        load: read,
        list: fs.makeDirectory(dir, { recursive: true }).pipe(
          Effect.flatMap(() => fs.readDirectory(dir)),
          Effect.mapError(
            (error) =>
              new SessionIoError({
                operation: "list",
                message: String(error),
              }),
          ),
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
                  Effect.tapError((error) =>
                    error._tag === "SessionNotFound"
                      ? Effect.void
                      : Console.warn(
                          `skipping session ${sessionId} (${entry}): ${error._tag}: ${error.message}`,
                        ),
                  ),
                  Effect.option,
                )
              },
            ),
          ),
          Effect.map((sessions) =>
            sessions
              .flatMap((session) => (Option.isSome(session) ? [metaOf(session.value)] : []))
              .sort(byRecency),
          ),
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
                revision: source.revision,
              }
              yield* write(forked)
              return metaOf(forked)
            }),
          ),
      })
    }),
  )
