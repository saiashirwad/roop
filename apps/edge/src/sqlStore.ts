import {
  metaFromOptions,
  SessionNotFound,
  SessionRecordSchema,
  SessionStore,
  sessionFrom,
  summaryFrom,
  type SessionMeta,
  type SessionRecord,
  type SessionSummary,
} from "@roop/core/SessionStore.ts"
import { Effect, Schema } from "effect"

export const ROOM_SCHEMA = `
CREATE TABLE IF NOT EXISTS records (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  entry TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

const decodeRecord = Schema.decodeUnknownSync(SessionRecordSchema)

type RecordRow = {
  readonly seq: number
  readonly id: string
  readonly session_id: string
  readonly created_at: number
  readonly entry: string
}

const recordFromRow = (row: RecordRow): SessionRecord =>
  decodeRecord({
    id: row.id,
    sessionId: row.session_id,
    createdAt: row.created_at,
    entry: JSON.parse(row.entry),
  })

/**
 * Durable-object-sqlite SessionStore scoped to a single room session.
 * `seq` (autoincrement) doubles as the replay cursor for reconnecting clients.
 */
export const makeRoomSessionStore = (
  sql: SqlStorage,
  sessionId: string,
): SessionStore["Service"] => {
  const readMeta = (): SessionMeta | undefined => {
    const rows = sql.exec("SELECT value FROM meta WHERE key = ?", "session").toArray()
    const row = rows[0] as { value: string } | undefined
    if (row === undefined) return undefined
    return JSON.parse(row.value) as SessionMeta
  }

  const readRecords = (): Array<SessionRecord> =>
    sql
      .exec("SELECT * FROM records WHERE session_id = ? ORDER BY seq", sessionId)
      .toArray()
      .map((row) => recordFromRow(row as unknown as RecordRow))

  return SessionStore.of({
    create: (options) =>
      Effect.sync(() => {
        let meta = readMeta()
        if (meta === undefined) {
          meta = metaFromOptions(options)
          sql.exec(
            "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
            "session",
            JSON.stringify(meta),
          )
        }
        return summaryFrom(sessionId, readRecords(), meta)
      }),

    append: (id, entry) =>
      Effect.suspend(() => {
        if (id !== sessionId || readMeta() === undefined) {
          return Effect.fail(new SessionNotFound({ sessionId: id }))
        }
        const record: SessionRecord = {
          id: crypto.randomUUID(),
          sessionId: id,
          createdAt: Date.now(),
          entry,
        }
        sql.exec(
          "INSERT INTO records (id, session_id, created_at, entry) VALUES (?, ?, ?, ?)",
          record.id,
          record.sessionId,
          record.createdAt,
          JSON.stringify(record.entry),
        )
        return Effect.succeed(record)
      }),

    get: (id) =>
      Effect.suspend(() => {
        if (id !== sessionId || readMeta() === undefined) {
          return Effect.fail(new SessionNotFound({ sessionId: id }))
        }
        return Effect.succeed(sessionFrom(sessionId, readRecords(), readMeta()))
      }),

    list: () =>
      Effect.sync((): ReadonlyArray<SessionSummary> => {
        const meta = readMeta()
        return meta === undefined ? [] : [summaryFrom(sessionId, readRecords(), meta)]
      }),
  })
}

/** Replay cursor helpers — seq is the client-facing position in the room log. */
export const lastSeq = (sql: SqlStorage): number => {
  const row = sql.exec("SELECT COALESCE(MAX(seq), 0) AS seq FROM records").toArray()[0] as
    | { seq: number }
    | undefined
  return row?.seq ?? 0
}

export const seqForRecord = (sql: SqlStorage, recordId: string): number => {
  const row = sql.exec("SELECT seq FROM records WHERE id = ?", recordId).toArray()[0] as
    | { seq: number }
    | undefined
  return row?.seq ?? 0
}

export const recordsAfter = (
  sql: SqlStorage,
  sessionId: string,
  after: number,
): ReadonlyArray<{ readonly seq: number; readonly record: SessionRecord }> =>
  sql
    .exec("SELECT * FROM records WHERE session_id = ? AND seq > ? ORDER BY seq", sessionId, after)
    .toArray()
    .map((row) => {
      const typed = row as unknown as RecordRow
      return { seq: typed.seq, record: recordFromRow(typed) }
    })
