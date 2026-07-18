import { AgentRunner, type StreamToolkit } from "@roop/core/AgentRunner.ts"
import { SessionHub } from "@roop/core/SessionHub.ts"
import { SessionLog } from "@roop/core/SessionLog.ts"
import type { Actor } from "@roop/core/SessionStore.ts"
import { Cause, Context, Deferred, Effect, Exit, Layer, Ref, Stream } from "effect"
import type { LanguageModel } from "effect/unstable/ai"
import { DoState } from "effect-workerd"

import { ROOM_SYSTEM_PROMPT } from "../prompt.ts"
import { RoomActor } from "../RoomActor.ts"
import { seqForRecord } from "../sqlStore.ts"

const QUEUE_SCHEMA = `
CREATE TABLE IF NOT EXISTS queue (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  text TEXT NOT NULL
);
`

type QueuedPrompt = {
  readonly actor: Actor
  readonly text: string
}

type ActiveRun = {
  readonly runId: string
  readonly interrupt: Deferred.Deferred<void>
}

const NO_MODEL_MESSAGE =
  "No model API key configured on the worker. Set KIMI_API_KEY, ZAI_API_KEY, or DEEPSEEK_API_KEY as a worker secret."

const getMeta = (sql: SqlStorage, key: string): string | undefined => {
  const row = sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0] as
    | { value: string }
    | undefined
  return row?.value
}

const setMeta = (sql: SqlStorage, key: string, value: string): void => {
  sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", key, value)
}

const deleteMeta = (sql: SqlStorage, key: string): void => {
  sql.exec("DELETE FROM meta WHERE key = ?", key)
}

const shiftQueue = (sql: SqlStorage): QueuedPrompt | undefined => {
  const row = sql
    .exec("SELECT seq, actor_id, actor_name, text FROM queue ORDER BY seq LIMIT 1")
    .toArray()[0] as
    | { seq: number; actor_id: string; actor_name: string; text: string }
    | undefined
  if (row === undefined) return undefined
  sql.exec("DELETE FROM queue WHERE seq = ?", row.seq)
  return { actor: { id: row.actor_id, name: row.actor_name }, text: row.text }
}

const enqueueSql = (sql: SqlStorage, actor: Actor, text: string): void => {
  sql.exec(
    "INSERT INTO queue (actor_id, actor_name, text) VALUES (?, ?, ?)",
    actor.id,
    actor.name,
    text,
  )
}

const queueNonEmpty = (sql: SqlStorage): boolean => {
  const row = sql.exec("SELECT seq FROM queue ORDER BY seq LIMIT 1").toArray()[0]
  return row !== undefined
}

export class PromptQueue extends Context.Service<
  PromptQueue,
  {
    readonly enqueue: (actor: Actor, text: string) => Effect.Effect<void>
    readonly interrupt: () => Effect.Effect<void>
    readonly isRunning: Effect.Effect<boolean>
  }
>()("roop/PromptQueue") {}

export type PromptQueueDeps = {
  readonly sessionId: string
  readonly model: LanguageModel.Service | undefined
  readonly toolkit: StreamToolkit
}

/**
 * Durable prompt queue + agent pump.
 *
 * ActorRuntime rebuilds `layer` per message; callers must cache this service
 * for the DO *instance* lifetime so the pump and interrupt Deferred stay shared.
 * `sql` is closed over from the constructing DoState — RoomLayers must drop the
 * bundle when DoState identity changes (hibernation recreates the DO).
 *
 * Record fan-out is forked once; `RoomActor.all.send` reads the live client set.
 */
export const makePromptQueue = (
  deps: PromptQueueDeps,
): Effect.Effect<
  PromptQueue["Service"],
  never,
  SessionLog | AgentRunner | SessionHub | DoState.DoState | RoomActor
> =>
  Effect.gen(function* () {
    // Bound to this DO instance only. Do not reuse across hibernation wakes.
    const sql = (yield* DoState.DoState).storage.sql
    sql.exec(QUEUE_SCHEMA)

    const log = yield* SessionLog
    const runner = yield* AgentRunner
    const hub = yield* SessionHub

    const pumping = yield* Ref.make(false)
    const activeRun = yield* Ref.make<ActiveRun | undefined>(undefined)

    // Hibernation recovery: close out a run that died mid-flight.
    const deadRunId = getMeta(sql, "activeRunId")
    if (deadRunId !== undefined) {
      yield* log
        .append(deps.sessionId, {
          _tag: "Agent",
          event: { _tag: "RunInterrupted", runId: deadRunId },
        })
        .pipe(Effect.ignore)
      deleteMeta(sql, "activeRunId")
    }

    // Continuous fan-out for this DO instance. Clients reconnect via hydrate backlog.
    yield* Stream.runForEach(hub.subscribe(deps.sessionId), (record) =>
      Effect.gen(function* () {
        const seq = seqForRecord(sql, record.id)
        yield* RoomActor.all.send("Record", { seq, record })
      }).pipe(Effect.ignore),
    ).pipe(Effect.forkDetach)

    const runAgent = (actor: Actor, prompt: string) =>
      Effect.gen(function* () {
        if (deps.model === undefined) {
          yield* log
            .append(deps.sessionId, {
              _tag: "Agent",
              event: { _tag: "RunFailed", message: NO_MODEL_MESSAGE },
            })
            .pipe(Effect.ignore)
          return
        }

        const runId = crypto.randomUUID()
        const interrupt = yield* Deferred.make<void>()
        const history = (yield* log.get(deps.sessionId)).records
        yield* Ref.set(activeRun, { runId, interrupt })
        setMeta(sql, "activeRunId", runId)

        const exit = yield* Stream.runDrain(
          runner.runOnSession({
            model: deps.model,
            toolkit: deps.toolkit,
            sessionId: deps.sessionId,
            history,
            prompt,
            runId,
            interrupt,
            systemPrompt: ROOM_SYSTEM_PROMPT,
            actor,
          }),
        ).pipe(Effect.exit)

        if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
          yield* log
            .append(deps.sessionId, {
              _tag: "Agent",
              event: { _tag: "RunFailed", message: Cause.pretty(exit.cause) },
            })
            .pipe(Effect.ignore)
        }

        yield* Ref.set(activeRun, undefined)
        deleteMeta(sql, "activeRunId")
      }).pipe(Effect.asVoid)

    const pumpLoop = Effect.gen(function* () {
      while (true) {
        const next = shiftQueue(sql)
        if (next === undefined) break
        yield* runAgent(next.actor, next.text)
      }
    }).pipe(
      Effect.ensuring(Ref.set(pumping, false)),
      Effect.tapCause((cause) =>
        Effect.sync(() => console.error("room pumpLoop failed", Cause.pretty(cause))),
      ),
    )

    const ensurePump = Effect.gen(function* () {
      const already = yield* Ref.get(pumping)
      if (already) return
      yield* Ref.set(pumping, true)
      // Detach so the pump outlives the per-message ActorRuntime scope.
      yield* Effect.forkDetach(pumpLoop)
    })

    if (queueNonEmpty(sql)) {
      yield* ensurePump
    }

    return PromptQueue.of({
      enqueue: (actor, text) =>
        Effect.gen(function* () {
          enqueueSql(sql, actor, text)
          yield* ensurePump
        }),
      interrupt: () =>
        Effect.gen(function* () {
          const run = yield* Ref.get(activeRun)
          if (run !== undefined) {
            yield* Deferred.succeed(run.interrupt, undefined).pipe(Effect.ignore)
          }
        }),
      isRunning: Ref.get(activeRun).pipe(Effect.map((run) => run !== undefined)),
    })
  })

export const PromptQueueLive = (deps: PromptQueueDeps) =>
  Layer.effect(PromptQueue, makePromptQueue(deps))
