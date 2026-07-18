import { AgentRunner, AgentRunnerLive, type StreamToolkit } from "@roop/core/AgentRunner.ts"
import { SessionHub, SessionHubLive } from "@roop/core/SessionHub.ts"
import { SessionLog, SessionLogLive } from "@roop/core/SessionLog.ts"
import { SessionStore, type Actor, type SessionRecord } from "@roop/core/SessionStore.ts"
import { Cause, Deferred, Effect, Exit, Layer, ManagedRuntime, Stream } from "effect"
import type { LanguageModel } from "effect/unstable/ai"

import type { Env } from "./env.ts"
import { FakeFsToolkit, fakeFsHandlers, FILES_SCHEMA, sqliteFileStorage } from "./fakefs.ts"
import { resolveRoomModel } from "./model.ts"
import { ROOM_SYSTEM_PROMPT } from "./prompt.ts"
import { decodeClientMessage, encodeServerMessage, type ServerMessage } from "./protocol.ts"
import {
  lastSeq,
  makeRoomSessionStore,
  recordsAfter,
  ROOM_SCHEMA,
  seqForRecord,
} from "./sqlStore.ts"

type Attachment = {
  readonly actorId: string
  readonly name: string
}

const MAX_NAME_LENGTH = 40

const sanitizeName = (raw: string | null): string => {
  const name = (raw ?? "").trim().slice(0, MAX_NAME_LENGTH)
  return name.length > 0 ? name : "anon"
}

const sanitizeCursor = (raw: string | null): number => {
  const value = Number(raw ?? "0")
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

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

type RoomServices = SessionLog | SessionHub | AgentRunner

const NO_MODEL_MESSAGE =
  "No model API key configured on the worker. Set KIMI_API_KEY, ZAI_API_KEY, or DEEPSEEK_API_KEY as a worker secret."

/**
 * One room = one shared session + one shared virtual workspace.
 *
 * True multiplayer: anyone may prompt (runs are serialized through a durable
 * queue) and anyone may interrupt the active run.
 *
 * Hibernation-safe: everything durable lives in ctx.storage; per-connection
 * identity lives in the WebSocket attachment. In-memory state (Effect
 * runtime, active run handle) is rebuilt in blockConcurrencyWhile on wake.
 */
export class Room {
  private readonly ctx: DurableObjectState
  private readonly env: Env
  private readonly sessionId: string
  private sql!: SqlStorage
  private runtime!: ManagedRuntime.ManagedRuntime<RoomServices, never>
  private log!: SessionLog["Service"]
  private runner!: AgentRunner["Service"]
  private toolkit!: StreamToolkit
  private model: LanguageModel.Service | undefined
  private activeRun:
    | { readonly runId: string; readonly interrupt: Deferred.Deferred<void> }
    | undefined
  private pumping = false

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx
    this.env = env
    this.sessionId = ctx.id.toString()
    this.ctx.blockConcurrencyWhile(() => this.init())
  }

  private async init(): Promise<void> {
    this.sql = this.ctx.storage.sql
    this.sql.exec(ROOM_SCHEMA)
    this.sql.exec(FILES_SCHEMA)
    this.sql.exec(QUEUE_SCHEMA)

    const storeLive = Layer.succeed(SessionStore, makeRoomSessionStore(this.sql, this.sessionId))
    const logLive = SessionLogLive.pipe(Layer.provide(storeLive), Layer.provide(SessionHubLive))
    const runnerLive = AgentRunnerLive.pipe(Layer.provide(logLive))
    this.runtime = ManagedRuntime.make(Layer.mergeAll(logLive, SessionHubLive, runnerLive))

    const { log, runner, hub } = await this.runtime.runPromise(
      Effect.gen(function* () {
        const log = yield* SessionLog
        const runner = yield* AgentRunner
        const hub = yield* SessionHub
        // Idempotent: the room session exists exactly once per durable object.
        yield* log.create({ kind: "main", title: "room" })
        return { log, runner, hub }
      }),
    )
    this.log = log
    this.runner = runner

    const files = sqliteFileStorage(this.sql)
    this.toolkit = (await Effect.runPromise(
      Effect.gen(function* () {
        return yield* FakeFsToolkit
      }).pipe(Effect.provide(FakeFsToolkit.toLayer(Effect.succeed(fakeFsHandlers(files))))),
    )) as unknown as StreamToolkit

    this.model = await this.runtime.runPromise(resolveRoomModel(this.env))

    // Live tail: every appended record fans out to all connected clients.
    this.runtime.runFork(
      Stream.runForEach(hub.subscribe(this.sessionId), (record) =>
        Effect.sync(() => {
          this.broadcastRecord(record)
        }),
      ),
    )

    // Hibernation recovery: a run active when the isolate died left no
    // terminal event — close it out so the log and clients stay consistent.
    const deadRunId = this.getMeta("activeRunId")
    if (deadRunId !== undefined) {
      await this.runtime
        .runPromise(
          this.log.append(this.sessionId, {
            _tag: "Agent",
            event: { _tag: "RunInterrupted", runId: deadRunId },
          }),
        )
        .catch(() => undefined)
      this.deleteMeta("activeRunId")
    }

    // Resume any prompts queued before the isolate went away.
    this.pump()
  }

  // --- presence -----------------------------------------------------------

  private members(): Array<Actor> {
    const members: Array<Actor> = []
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null
      if (attachment !== null) {
        members.push({ id: attachment.actorId, name: attachment.name })
      }
    }
    return members
  }

  private actorOf(ws: WebSocket): Actor | undefined {
    const attachment = ws.deserializeAttachment() as Attachment | null
    return attachment === null ? undefined : { id: attachment.actorId, name: attachment.name }
  }

  // --- fan-out ------------------------------------------------------------

  private send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(encodeServerMessage(message))
    } catch {
      // Socket already closing; close/error handlers will drop it.
    }
  }

  private broadcast(message: ServerMessage): void {
    for (const ws of this.ctx.getWebSockets()) {
      this.send(ws, message)
    }
  }

  private broadcastRecord(record: SessionRecord): void {
    this.broadcast({ type: "record", seq: seqForRecord(this.sql, record.id), record })
  }

  private broadcastPresence(): void {
    this.broadcast({ type: "presence", members: this.members() })
  }

  // --- run queue ------------------------------------------------------------

  private getMeta(key: string): string | undefined {
    const row = this.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0] as
      | { value: string }
      | undefined
    return row?.value
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", key, value)
  }

  private deleteMeta(key: string): void {
    this.sql.exec("DELETE FROM meta WHERE key = ?", key)
  }

  private enqueue(actor: Actor, text: string): void {
    this.sql.exec(
      "INSERT INTO queue (actor_id, actor_name, text) VALUES (?, ?, ?)",
      actor.id,
      actor.name,
      text,
    )
    this.pump()
  }

  private shiftQueue(): QueuedPrompt | undefined {
    const row = this.sql
      .exec("SELECT seq, actor_id, actor_name, text FROM queue ORDER BY seq LIMIT 1")
      .toArray()[0] as
      | { seq: number; actor_id: string; actor_name: string; text: string }
      | undefined
    if (row === undefined) return undefined
    this.sql.exec("DELETE FROM queue WHERE seq = ?", row.seq)
    return { actor: { id: row.actor_id, name: row.actor_name }, text: row.text }
  }

  private pump(): void {
    if (this.pumping) return
    this.pumping = true
    this.ctx.waitUntil(
      this.pumpLoop()
        .catch((error: unknown) => {
          console.error("room pumpLoop failed", error)
        })
        .finally(() => {
          this.pumping = false
        }),
    )
  }

  private async pumpLoop(): Promise<void> {
    while (true) {
      const next = this.shiftQueue()
      if (next === undefined) return
      await this.runAgent(next.actor, next.text)
    }
  }

  private async runAgent(actor: Actor, prompt: string): Promise<void> {
    if (this.model === undefined) {
      await this.runtime
        .runPromise(
          this.log.append(this.sessionId, {
            _tag: "Agent",
            event: { _tag: "RunFailed", message: NO_MODEL_MESSAGE },
          }),
        )
        .catch(() => undefined)
      return
    }

    const runId = crypto.randomUUID()
    const interrupt = await this.runtime.runPromise(Deferred.make<void>())
    const history = (await this.runtime.runPromise(this.log.get(this.sessionId))).records
    this.activeRun = { runId, interrupt }
    // Durable marker: if the isolate dies mid-run, init() finds this and
    // closes the run out as interrupted.
    this.setMeta("activeRunId", runId)

    try {
      const exit = await this.runtime.runPromiseExit(
        Stream.runDrain(
          this.runner.runOnSession({
            model: this.model,
            toolkit: this.toolkit,
            sessionId: this.sessionId,
            history,
            prompt,
            runId,
            interrupt,
            systemPrompt: ROOM_SYSTEM_PROMPT,
            actor,
          }),
        ),
      )
      // runPromptOnSession already logs RunFailed for typed errors; this is for defects.
      if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
        await this.runtime
          .runPromise(
            this.log.append(this.sessionId, {
              _tag: "Agent",
              event: { _tag: "RunFailed", message: Cause.pretty(exit.cause) },
            }),
          )
          .catch(() => undefined)
      }
    } finally {
      this.activeRun = undefined
      this.deleteMeta("activeRunId")
    }
  }

  // --- endpoints ----------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("roop-edge room: connect with a WebSocket", { status: 426 })
    }

    const url = new URL(request.url)
    const name = sanitizeName(url.searchParams.get("name"))
    const after = sanitizeCursor(url.searchParams.get("after"))

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]

    this.ctx.acceptWebSocket(server)
    const actor: Actor = { id: crypto.randomUUID(), name }
    server.serializeAttachment({ actorId: actor.id, name: actor.name } satisfies Attachment)

    // Single-threaded: welcome + backlog send without interleaving appends.
    this.send(server, {
      type: "welcome",
      self: actor,
      members: this.members(),
      cursor: lastSeq(this.sql),
      running: this.activeRun !== undefined,
    })
    for (const { seq, record } of recordsAfter(this.sql, this.sessionId, after)) {
      this.send(server, { type: "record", seq, record })
    }
    this.broadcastPresence()

    return new Response(null, { status: 101, webSocket: client })
  }

  // --- hibernatable WebSocket handlers ------------------------------------

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const message = decodeClientMessage(raw)
    if (message === undefined) {
      this.send(ws, { type: "error", message: "Malformed message" })
      return
    }
    const actor = this.actorOf(ws)
    if (actor === undefined) {
      this.send(ws, { type: "error", message: "Missing attachment; reconnect" })
      return
    }

    switch (message.type) {
      case "prompt": {
        this.enqueue(actor, message.text)
        break
      }
      case "interrupt": {
        const run = this.activeRun
        if (run !== undefined) {
          await this.runtime.runPromise(
            Deferred.succeed(run.interrupt, undefined).pipe(Effect.ignore),
          )
        }
        break
      }
    }
  }

  async webSocketClose(): Promise<void> {
    this.broadcastPresence()
  }

  async webSocketError(): Promise<void> {
    this.broadcastPresence()
  }
}
