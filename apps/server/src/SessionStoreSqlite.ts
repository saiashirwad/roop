import { DatabaseSync } from "node:sqlite"

import type { SessionMeta, SessionRecord } from "@roop/core/SessionStore.ts"
import {
  metaFromOptions,
  sessionFrom,
  SessionMetaSchema,
  SessionNotFound,
  SessionRecordSchema,
  SessionStore,
  summaryFrom,
} from "@roop/core/SessionStore.ts"
import { Effect, Layer, Option, Schema } from "effect"

const decodeRecordOption = Schema.decodeUnknownOption(SessionRecordSchema)
const decodeMetaOption = Schema.decodeUnknownOption(SessionMetaSchema)

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * SQLite session store via Node `node:sqlite` (app-only — core stays host-neutral).
 * One db file (or `:memory:`); semantics match memory/jsonl, corrupt rows skipped.
 */
export const SessionStoreSqliteLive = (dbPath: string): Layer.Layer<SessionStore> =>
  Layer.effect(
    SessionStore,
    Effect.gen(function* () {
      const db = new DatabaseSync(dbPath)
      yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))

      db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          meta TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS records (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL,
          session_id TEXT NOT NULL REFERENCES sessions(id),
          record TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS records_by_session ON records(session_id, seq);
      `)

      const insertSession = db.prepare("INSERT INTO sessions (id, meta) VALUES (?, ?)")
      const selectSession = db.prepare("SELECT meta FROM sessions WHERE id = ?")
      const selectSessions = db.prepare("SELECT id, meta FROM sessions")
      const insertRecord = db.prepare(
        "INSERT INTO records (id, session_id, record) VALUES (?, ?, ?)",
      )
      const selectRecords = db.prepare(
        "SELECT record FROM records WHERE session_id = ? ORDER BY seq",
      )

      const readMeta = (row: unknown): SessionMeta | undefined => {
        const raw = (row as { meta: string } | undefined)?.meta
        if (raw === undefined) return undefined
        const decoded = decodeMetaOption(parseJson(raw))
        return Option.isSome(decoded) ? decoded.value : undefined
      }

      const readRecords = (sessionId: string): Array<SessionRecord> => {
        const rows = selectRecords.all(sessionId) as Array<{ record: string }>
        const records: Array<SessionRecord> = []
        for (const row of rows) {
          const decoded = decodeRecordOption(parseJson(row.record))
          if (Option.isSome(decoded)) {
            records.push(decoded.value)
          }
        }
        return records
      }

      return SessionStore.of({
        create: (options) =>
          Effect.sync(() => {
            const sessionId = crypto.randomUUID()
            const meta = metaFromOptions(options)
            insertSession.run(sessionId, JSON.stringify(meta))
            return summaryFrom(sessionId, [], meta)
          }),

        append: (sessionId, entry) =>
          Effect.suspend(() => {
            if (selectSession.get(sessionId) === undefined) {
              return new SessionNotFound({ sessionId })
            }
            const record: SessionRecord = {
              id: crypto.randomUUID(),
              sessionId,
              createdAt: Date.now(),
              entry,
            }
            insertRecord.run(record.id, sessionId, JSON.stringify(record))
            return Effect.succeed(record)
          }),

        get: (sessionId) =>
          Effect.suspend(() => {
            const row = selectSession.get(sessionId)
            if (row === undefined) {
              return new SessionNotFound({ sessionId })
            }
            return Effect.succeed(sessionFrom(sessionId, readRecords(sessionId), readMeta(row)))
          }),

        list: () =>
          Effect.sync(() => {
            const rows = selectSessions.all() as Array<{ id: string; meta: string }>
            return rows
              .map((row) => summaryFrom(row.id, readRecords(row.id), readMeta(row)))
              .sort((a, b) => b.updatedAt - a.updatedAt)
          }),
      })
    }),
  )
