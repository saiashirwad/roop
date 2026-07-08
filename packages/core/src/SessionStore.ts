import { Context, Effect, FileSystem, Layer, Option, Path, Ref, Schema } from "effect"

import { AgentEventSchema } from "./AgentEvent.ts"

export class SessionNotFound extends Schema.TaggedErrorClass<SessionNotFound>()("SessionNotFound", {
  sessionId: Schema.String,
}) {}

export const SessionRecordSchema = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  createdAt: Schema.Number,
  entry: Schema.Union([
    Schema.TaggedStruct("UserPrompt", {
      prompt: Schema.String,
    }),
    Schema.TaggedStruct("Agent", {
      event: AgentEventSchema,
    }),
  ]),
})

export type SessionRecord = typeof SessionRecordSchema.Type

export type SessionCreateOptions = {
  readonly parentSessionId?: string | undefined
  readonly kind?: "main" | "subagent" | undefined
  readonly agentId?: string | undefined
  readonly title?: string | undefined
}

export const SessionSummarySchema = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  recordCount: Schema.Number,
  title: Schema.optionalKey(Schema.String),
  parentSessionId: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(Schema.Literals(["main", "subagent"])),
  agentId: Schema.optionalKey(Schema.String),
})

export type SessionSummary = typeof SessionSummarySchema.Type

export const SessionSchema = Schema.Struct({
  id: Schema.String,
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  records: Schema.Array(SessionRecordSchema),
  parentSessionId: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(Schema.Literals(["main", "subagent"])),
  agentId: Schema.optionalKey(Schema.String),
})

export type Session = typeof SessionSchema.Type

export type SessionMeta = {
  readonly parentSessionId?: string | undefined
  readonly kind?: "main" | "subagent" | undefined
  readonly agentId?: string | undefined
  readonly title?: string | undefined
  readonly createdAt: number
}

export const SessionMetaSchema = Schema.Struct({
  parentSessionId: Schema.optionalKey(Schema.String),
  kind: Schema.optionalKey(Schema.Literals(["main", "subagent"])),
  agentId: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  createdAt: Schema.Number,
})

/** Append-only session durability (no live fan-out — use `SessionLog` for that). */
export class SessionStore extends Context.Service<
  SessionStore,
  {
    readonly create: (options?: SessionCreateOptions) => Effect.Effect<SessionSummary>
    readonly append: (
      sessionId: string,
      entry: SessionRecord["entry"],
    ) => Effect.Effect<SessionRecord, SessionNotFound>
    readonly get: (sessionId: string) => Effect.Effect<Session, SessionNotFound>
    readonly list: () => Effect.Effect<ReadonlyArray<SessionSummary>>
  }
>()("roop/SessionStore") {}

/** Shared summary derivation for alternate store backends. */
export const summaryFrom = (
  sessionId: string,
  records: ReadonlyArray<SessionRecord>,
  meta: SessionMeta | undefined,
): SessionSummary => {
  const first = records[0]
  const last = records[records.length - 1]
  const createdAt = meta?.createdAt ?? first?.createdAt ?? Date.now()
  const updatedAt = last?.createdAt ?? createdAt
  const userPrompt = records.find((record) => record.entry._tag === "UserPrompt")
  const titleFromPrompt =
    userPrompt?.entry._tag === "UserPrompt" ? userPrompt.entry.prompt.slice(0, 80) : undefined
  const title = meta?.title ?? titleFromPrompt

  return {
    id: sessionId,
    createdAt,
    updatedAt,
    recordCount: records.length,
    ...(title !== undefined ? { title } : {}),
    ...(meta?.parentSessionId !== undefined ? { parentSessionId: meta.parentSessionId } : {}),
    ...(meta?.kind !== undefined ? { kind: meta.kind } : {}),
    ...(meta?.agentId !== undefined ? { agentId: meta.agentId } : {}),
  }
}

export const sessionFrom = (
  sessionId: string,
  records: ReadonlyArray<SessionRecord>,
  meta: SessionMeta | undefined,
): Session => {
  const summary = summaryFrom(sessionId, records, meta)
  return {
    id: sessionId,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    records,
    ...(summary.parentSessionId !== undefined ? { parentSessionId: summary.parentSessionId } : {}),
    ...(summary.kind !== undefined ? { kind: summary.kind } : {}),
    ...(summary.agentId !== undefined ? { agentId: summary.agentId } : {}),
  }
}

export const metaFromOptions = (options: SessionCreateOptions | undefined): SessionMeta => ({
  createdAt: Date.now(),
  ...(options?.parentSessionId !== undefined ? { parentSessionId: options.parentSessionId } : {}),
  ...(options?.kind !== undefined ? { kind: options.kind } : { kind: "main" as const }),
  ...(options?.agentId !== undefined ? { agentId: options.agentId } : {}),
  ...(options?.title !== undefined ? { title: options.title } : {}),
})

export const SessionStoreMemoryLive = Layer.effect(
  SessionStore,
  Effect.gen(function* () {
    const state = yield* Ref.make(
      new Map<string, { records: Array<SessionRecord>; meta: SessionMeta }>(),
    )

    return SessionStore.of({
      create: (options) =>
        Effect.gen(function* () {
          const sessionId = crypto.randomUUID()
          const meta = metaFromOptions(options)
          yield* Ref.update(state, (map) => {
            const next = new Map(map)
            next.set(sessionId, { records: [], meta })
            return next
          })
          return summaryFrom(sessionId, [], meta)
        }),

      append: (sessionId, entry) =>
        Effect.gen(function* () {
          const record: SessionRecord = {
            id: crypto.randomUUID(),
            sessionId,
            createdAt: Date.now(),
            entry,
          }
          const wrote = yield* Ref.modify(state, (map) => {
            const bucket = map.get(sessionId)
            if (bucket === undefined) {
              return [false as boolean, map] as const
            }
            const next = new Map(map)
            next.set(sessionId, {
              meta: bucket.meta,
              records: [...bucket.records, record],
            })
            return [true as boolean, next] as const
          })
          if (!wrote) {
            return yield* new SessionNotFound({ sessionId })
          }
          return record
        }),

      get: (sessionId) =>
        Effect.gen(function* () {
          const map = yield* Ref.get(state)
          const bucket = map.get(sessionId)
          if (bucket === undefined) {
            return yield* new SessionNotFound({ sessionId })
          }
          return sessionFrom(sessionId, bucket.records, bucket.meta)
        }),

      list: () =>
        Effect.gen(function* () {
          const map = yield* Ref.get(state)
          return [...map.entries()]
            .map(([sessionId, bucket]) => summaryFrom(sessionId, bucket.records, bucket.meta))
            .sort((a, b) => b.updatedAt - a.updatedAt)
        }),
    })
  }),
)

const decodeRecordOption = Schema.decodeUnknownOption(SessionRecordSchema)
const decodeMetaOption = Schema.decodeUnknownOption(SessionMetaSchema)

const parseRecordLine = (line: string): Option.Option<SessionRecord> => {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return Option.none()
  }
  return decodeRecordOption(value)
}

/** JSONL store: `{sessionId}.jsonl` + optional `{sessionId}.meta.json`. */
export const SessionStoreJsonlLive = (
  directory: string,
): Layer.Layer<SessionStore, never, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    SessionStore,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const sessionPath = (sessionId: string) => path.join(directory, `${sessionId}.jsonl`)
      const metaPath = (sessionId: string) => path.join(directory, `${sessionId}.meta.json`)

      const ensureDirectory = fs.makeDirectory(directory, { recursive: true }).pipe(Effect.orDie)

      const readMeta = (sessionId: string): Effect.Effect<SessionMeta | undefined> =>
        Effect.gen(function* () {
          const file = metaPath(sessionId)
          const exists = yield* fs.exists(file).pipe(Effect.orDie)
          if (!exists) return undefined
          const content = yield* fs.readFileString(file).pipe(Effect.orDie)
          let value: unknown
          try {
            value = JSON.parse(content)
          } catch {
            return undefined
          }
          const decoded = decodeMetaOption(value)
          return Option.isSome(decoded) ? decoded.value : undefined
        })

      const writeMeta = (sessionId: string, meta: SessionMeta) =>
        fs.writeFileString(metaPath(sessionId), `${JSON.stringify(meta)}\n`).pipe(Effect.orDie)

      const readRecords = (sessionId: string) =>
        Effect.gen(function* () {
          const file = sessionPath(sessionId)
          const exists = yield* fs.exists(file).pipe(Effect.orDie)
          if (!exists) {
            return yield* new SessionNotFound({ sessionId })
          }
          const content = yield* fs.readFileString(file).pipe(Effect.orDie)
          const lines = content.split("\n").filter((line) => line.trim().length > 0)
          const records: Array<SessionRecord> = []
          for (const line of lines) {
            const record = parseRecordLine(line)
            if (Option.isSome(record)) {
              records.push(record.value)
            }
          }
          return records
        })

      return SessionStore.of({
        create: (options) =>
          Effect.gen(function* () {
            yield* ensureDirectory
            const sessionId = crypto.randomUUID()
            const meta = metaFromOptions(options)
            yield* fs.writeFileString(sessionPath(sessionId), "").pipe(Effect.orDie)
            yield* writeMeta(sessionId, meta)
            return summaryFrom(sessionId, [], meta)
          }),

        append: (sessionId, entry) =>
          Effect.gen(function* () {
            yield* ensureDirectory
            const file = sessionPath(sessionId)
            const exists = yield* fs.exists(file).pipe(Effect.orDie)
            if (!exists) {
              return yield* new SessionNotFound({ sessionId })
            }
            const record: SessionRecord = {
              id: crypto.randomUUID(),
              sessionId,
              createdAt: Date.now(),
              entry,
            }
            const line = `${JSON.stringify(record)}\n`
            yield* fs.writeFileString(file, line, { flag: "a" }).pipe(Effect.orDie)
            return record
          }),

        get: (sessionId) =>
          Effect.gen(function* () {
            const records = yield* readRecords(sessionId)
            const meta = yield* readMeta(sessionId)
            return sessionFrom(sessionId, records, meta)
          }),

        list: () =>
          Effect.gen(function* () {
            yield* ensureDirectory
            const entries = yield* fs.readDirectory(directory).pipe(Effect.orDie)
            const summaries: Array<SessionSummary> = []
            for (const entry of entries) {
              if (!entry.endsWith(".jsonl")) {
                continue
              }
              const sessionId = entry.slice(0, -".jsonl".length)
              const records = yield* readRecords(sessionId).pipe(
                Effect.catchTag("SessionNotFound", () => Effect.succeed<Array<SessionRecord>>([])),
                Effect.catch(() => Effect.succeed<Array<SessionRecord>>([])),
              )
              const meta = yield* readMeta(sessionId)
              summaries.push(summaryFrom(sessionId, records, meta))
            }
            return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
          }),
      })
    }),
  )
