/**
 * A durable file-system Journal provider.
 *
 * Layout, under `directory`:
 *
 * - `<encodeURIComponent(sessionId)>.jsonl`: the session's events, one encoded
 *   `JournalEvent` per line. This log is the source of truth. `/` and `:` in
 *   session ids are percent-encoded, so child session ids are safe file names.
 * - `<encodeURIComponent(sessionId)>.meta.json`: the session's index entry
 *   (an encoded `SessionSummary`), so `list` never reads a log. It is a cache
 *   rebuilt from the log when missing or unreadable.
 *
 * Write discipline:
 *
 * - Every append is one `writeFile` with `{ flag: "a" }` for the whole batch,
 *   and every append or delete runs under a per-session mutex. The revision
 *   is the number of complete lines on disk, re-read on every append, so the
 *   layer never trusts a cached count.
 * - A crash mid-append can leave a torn final line without a newline. `load`
 *   ignores such a tail; the next append truncates it (write-temp-and-rename)
 *   before appending, so a torn line never breaks a later load or append.
 * - The index entry is written with write-temp-and-rename after the log. A
 *   crash between the two leaves an index entry that lags the log by one
 *   batch until the next append; `load` is unaffected.
 *
 * One process should own a directory: the mutex is in-process only.
 */
import { DomainIds, Event, Journal as JournalModule } from "@roop/agent"
import {
  Clock,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  type PlatformError,
  Predicate,
  Ref,
  Schema,
  Semaphore,
} from "effect"

const { SessionId } = DomainIds
const { EVENT_VERSION, JournalEvent, encodeJournalEvent } = Event
const {
  Journal,
  JournalEmptyAppend,
  JournalError,
  JournalFutureVersion,
  JournalRevisionConflict,
  SessionSummarySchema,
  emptySessionMetadata,
  foldSessionMetadata,
  validateJournalEvent,
} = JournalModule
type SessionId = DomainIds.SessionId
type JournalEvent = Event.JournalEvent
type Revision = JournalModule.Revision
type JournalSnapshot = JournalModule.JournalSnapshot
type SessionSummary = JournalModule.SessionSummary
type SessionMetadata = JournalModule.SessionMetadata
type JournalOperation = JournalModule.JournalError["operation"]

export interface JournalFsOptions {
  /** The directory that holds one log and one index entry per session. It is created if missing. */
  readonly directory: string
}

const LOG_SUFFIX = ".jsonl"
const META_SUFFIX = ".meta.json"
const TEMP_SUFFIX = ".tmp"

const decodeJson = Schema.decodeEffect(Schema.UnknownFromJsonString)
const decodeEvent = Schema.decodeUnknownEffect(JournalEvent)
const encodeSummary = Schema.encodeEffect(Schema.fromJsonString(SessionSummarySchema))
const decodeSummary = Schema.decodeEffect(Schema.fromJsonString(SessionSummarySchema))

const platformFailure =
  (operation: JournalOperation, sessionId: SessionId | undefined) =>
  (error: PlatformError.PlatformError): JournalModule.JournalError =>
    sessionId === undefined
      ? new JournalError({ operation, detail: error.message })
      : new JournalError({ operation, sessionId, detail: error.message })

const isNotFound = (error: PlatformError.PlatformError): boolean => error.reason._tag === "NotFound"

interface ParsedLog {
  /** Complete lines, in order. Blank lines are skipped. */
  readonly lines: ReadonlyArray<string>
  /** True when the file ends in a line without a newline (a torn append). */
  readonly torn: boolean
}

const parseLog = (content: string): ParsedLog => {
  if (content.length === 0) return { lines: [], torn: false }
  const segments = content.split("\n")
  const tail = segments.pop() ?? ""
  return { lines: segments.filter((line) => line.length > 0), torn: tail.length > 0 }
}

const summaryOf = (
  sessionId: SessionId,
  revision: Revision,
  createdAt: number,
  updatedAt: number,
  metadata: SessionMetadata,
): SessionSummary => ({
  sessionId,
  revision,
  createdAt,
  updatedAt,
  title: metadata.title,
  cwd: metadata.cwd,
})

const metadataOf = (summary: SessionSummary): SessionMetadata => ({
  title: summary.title,
  cwd: summary.cwd,
})

/** A Journal stored as NDJSON logs in `options.directory`. */
export const layer = (
  options: JournalFsOptions,
): Layer.Layer<JournalModule.Journal, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    Journal,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = options.directory
      yield* Effect.orDie(fs.makeDirectory(directory, { recursive: true }))

      const locks = yield* Ref.make(new Map<string, Semaphore.Semaphore>())
      const lockFor = (sessionId: string) =>
        Ref.modify(locks, (map) => {
          const existing = map.get(sessionId)
          if (existing !== undefined) return [existing, map] as const
          const created = Semaphore.makeUnsafe(1)
          return [created, new Map(map).set(sessionId, created)] as const
        })
      const withSessionLock = <A, E, R>(sessionId: string, effect: Effect.Effect<A, E, R>) =>
        Effect.flatMap(lockFor(sessionId), (lock) => lock.withPermit(effect))

      const logPath = (sessionId: string) =>
        path.join(directory, `${encodeURIComponent(sessionId)}${LOG_SUFFIX}`)
      const metaPath = (sessionId: string) =>
        path.join(directory, `${encodeURIComponent(sessionId)}${META_SUFFIX}`)

      /** Read a log, treating a missing file as empty. */
      const readLog = (operation: JournalOperation, sessionId: SessionId) =>
        fs.readFileString(logPath(sessionId)).pipe(
          Effect.map(parseLog),
          Effect.catchIf(isNotFound, () => Effect.succeed(parseLog(""))),
          Effect.mapError(platformFailure(operation, sessionId)),
        )

      const decodeLine = Effect.fn("JournalFs.decodeLine")(function* (
        sessionId: SessionId,
        line: string,
        index: number,
      ) {
        const json = yield* decodeJson(line).pipe(
          Effect.mapError(
            (error) =>
              new JournalError({
                operation: "decode",
                sessionId,
                detail: `line ${index + 1}: ${error.message}`,
              }),
          ),
        )
        if (
          Predicate.hasProperty(json, "version") &&
          typeof json.version === "number" &&
          json.version > EVENT_VERSION
        ) {
          return yield* new JournalFutureVersion({ sessionId, version: json.version })
        }
        return yield* decodeEvent(json).pipe(
          Effect.mapError(
            (error) =>
              new JournalError({
                operation: "decode",
                sessionId,
                detail: `line ${index + 1}: ${error.message}`,
              }),
          ),
        )
      })

      const decodeLines = (sessionId: SessionId, lines: ReadonlyArray<string>) =>
        Effect.forEach(lines, (line, index) => decodeLine(sessionId, line, index))

      /** Replace a file's content atomically: write a sibling temp file, then rename over it. */
      const replaceFile = (target: string, content: string) =>
        fs
          .writeFileString(`${target}${TEMP_SUFFIX}`, content)
          .pipe(Effect.andThen(fs.rename(`${target}${TEMP_SUFFIX}`, target)))

      const readMeta = (sessionId: SessionId) =>
        fs.readFileString(metaPath(sessionId)).pipe(
          Effect.flatMap((content) => decodeSummary(content)),
          Effect.option,
        )

      const writeMeta = (operation: JournalOperation, summary: SessionSummary) =>
        encodeSummary(summary).pipe(
          Effect.mapError(
            (error) =>
              new JournalError({
                operation,
                sessionId: summary.sessionId,
                detail: error.message,
              }),
          ),
          Effect.flatMap((content) =>
            replaceFile(metaPath(summary.sessionId), content).pipe(
              Effect.mapError(platformFailure(operation, summary.sessionId)),
            ),
          ),
        )

      const load = Effect.fn("JournalFs.load")(function* (sessionId: SessionId | string) {
        const sid = SessionId.make(sessionId)
        const log = yield* readLog("load", sid)
        const events = yield* decodeLines(sid, log.lines)
        return { sessionId: sid, revision: events.length, events } satisfies JournalSnapshot
      })

      const append = Effect.fn("JournalFs.append")(function* (
        sessionId: SessionId | string,
        expectedRevision: Revision,
        events: readonly [JournalEvent, ...JournalEvent[]],
      ) {
        const sid = SessionId.make(sessionId)
        if (events.length === 0) return yield* new JournalEmptyAppend({ sessionId: sid })
        yield* Effect.forEach(events, (event) => validateJournalEvent(sid, event), {
          discard: true,
        })
        const encodedLines = yield* Effect.forEach(events, (event) =>
          encodeJournalEvent(event).pipe(
            Effect.map((encoded) => JSON.stringify(encoded)),
            Effect.mapError(
              (error) =>
                new JournalError({ operation: "append", sessionId: sid, detail: error.message }),
            ),
          ),
        )
        return yield* withSessionLock(
          sid,
          Effect.gen(function* () {
            const log = yield* readLog("append", sid)
            const actualRevision = log.lines.length
            if (actualRevision !== expectedRevision) {
              return yield* new JournalRevisionConflict({
                sessionId: sid,
                expectedRevision,
                actualRevision,
              })
            }
            if (log.torn) {
              // Drop the torn tail before appending so the new batch starts on a fresh line.
              yield* replaceFile(
                logPath(sid),
                log.lines.length === 0 ? "" : `${log.lines.join("\n")}\n`,
              ).pipe(Effect.mapError(platformFailure("append", sid)))
            }
            yield* fs
              .writeFileString(logPath(sid), `${encodedLines.join("\n")}\n`, { flag: "a" })
              .pipe(Effect.mapError(platformFailure("append", sid)))
            const revision = actualRevision + events.length

            const now = yield* Clock.currentTimeMillis
            const previous = yield* readMeta(sid)
            const base = yield* Option.match(previous, {
              onSome: (summary) =>
                Effect.succeed({ createdAt: summary.createdAt, metadata: metadataOf(summary) }),
              onNone: () =>
                // No index entry: rebuild metadata from the events already on disk.
                decodeLines(sid, log.lines).pipe(
                  Effect.map((existing) => ({
                    createdAt: now,
                    metadata: foldSessionMetadata(emptySessionMetadata, existing),
                  })),
                ),
            })
            yield* writeMeta(
              "append",
              summaryOf(
                sid,
                revision,
                base.createdAt,
                now,
                foldSessionMetadata(base.metadata, events),
              ),
            )
            return revision
          }),
        )
      })

      /** Rebuild a missing or unreadable index entry from its log. */
      const rebuildMeta = Effect.fn("JournalFs.rebuildMeta")(function* (sid: SessionId) {
        const log = yield* readLog("list", sid)
        const events = yield* decodeLines(sid, log.lines).pipe(
          Effect.catchTag("JournalFutureVersion", (error) =>
            Effect.fail(
              new JournalError({ operation: "list", sessionId: sid, detail: error.message }),
            ),
          ),
        )
        const info = yield* fs
          .stat(logPath(sid))
          .pipe(Effect.mapError(platformFailure("list", sid)))
        const modified = Option.match(info.mtime, {
          onNone: () => 0,
          onSome: (date) => date.getTime(),
        })
        const summary = summaryOf(
          sid,
          events.length,
          modified,
          modified,
          foldSessionMetadata(emptySessionMetadata, events),
        )
        yield* writeMeta("list", summary)
        return summary
      })

      const summaryFor = (sid: SessionId) =>
        readMeta(sid).pipe(
          Effect.flatMap(
            Option.match({
              onSome: (summary) => Effect.succeed(summary),
              onNone: () => withSessionLock(sid, rebuildMeta(sid)),
            }),
          ),
        )

      const list = Effect.gen(function* () {
        const names = yield* fs
          .readDirectory(directory)
          .pipe(Effect.mapError(platformFailure("list", undefined)))
        const ids = names
          .filter((name) => name.endsWith(LOG_SUFFIX))
          .map((name) => SessionId.make(decodeURIComponent(name.slice(0, -LOG_SUFFIX.length))))
        return yield* Effect.forEach(ids, summaryFor)
      }).pipe(Effect.withSpan("JournalFs.list"))

      const remove = Effect.fn("JournalFs.delete")(function* (sessionId: SessionId | string) {
        const sid = SessionId.make(sessionId)
        yield* withSessionLock(
          sid,
          Effect.forEach(
            [
              logPath(sid),
              `${logPath(sid)}${TEMP_SUFFIX}`,
              metaPath(sid),
              `${metaPath(sid)}${TEMP_SUFFIX}`,
            ],
            (file) => fs.remove(file, { force: true }),
            { discard: true },
          ).pipe(Effect.mapError(platformFailure("delete", sid))),
        )
      })

      return Journal.of({ load, append, list, delete: remove })
    }),
  )
