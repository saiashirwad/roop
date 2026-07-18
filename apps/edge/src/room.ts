import type { Actor } from "@roop/core/SessionStore.ts"

import type { Env } from "./env.ts"
import { decodeClientMessage, encodeServerMessage, type ServerMessage } from "./protocol.ts"

type Attachment = {
  readonly actorId: string
  readonly name: string
}

const MAX_NAME_LENGTH = 40

const sanitizeName = (raw: string | null): string => {
  const name = (raw ?? "").trim().slice(0, MAX_NAME_LENGTH)
  return name.length > 0 ? name : "anon"
}

/**
 * One room = one shared session + one shared virtual workspace.
 *
 * Hibernation-safe: everything durable lives in ctx.storage; per-connection
 * identity lives in the WebSocket attachment. In-memory state (Effect
 * runtime, active run handle) is rebuilt in blockConcurrencyWhile on wake.
 */
export class Room {
  private readonly ctx: DurableObjectState

  constructor(ctx: DurableObjectState, _env: Env) {
    this.ctx = ctx
    this.ctx.blockConcurrencyWhile(() => this.init())
  }

  private async init(): Promise<void> {
    // Storage migrations + Effect runtime land in the next commits.
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
    return attachment === null
      ? undefined
      : { id: attachment.actorId, name: attachment.name }
  }

  private broadcast(message: ServerMessage): void {
    const frame = encodeServerMessage(message)
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(frame)
      } catch {
        // Socket already closing; close/error handlers will drop it.
      }
    }
  }

  private broadcastPresence(): void {
    this.broadcast({ type: "presence", members: this.members() })
  }

  // --- endpoints ----------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("roop-edge room: connect with a WebSocket", { status: 426 })
    }

    const url = new URL(request.url)
    const name = sanitizeName(url.searchParams.get("name"))

    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]

    this.ctx.acceptWebSocket(server)
    const actor: Actor = { id: crypto.randomUUID(), name }
    server.serializeAttachment({ actorId: actor.id, name: actor.name } satisfies Attachment)

    server.send(
      encodeServerMessage({
        type: "welcome",
        self: actor,
        members: this.members(),
        cursor: 0,
        running: false,
      }),
    )
    this.broadcastPresence()

    return new Response(null, { status: 101, webSocket: client })
  }

  // --- hibernatable WebSocket handlers ------------------------------------

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const message = decodeClientMessage(raw)
    if (message === undefined) {
      ws.send(encodeServerMessage({ type: "error", message: "Malformed message" }))
      return
    }
    const actor = this.actorOf(ws)
    if (actor === undefined) {
      ws.send(encodeServerMessage({ type: "error", message: "Missing attachment; reconnect" }))
      return
    }

    switch (message.type) {
      case "prompt": {
        ws.send(
          encodeServerMessage({ type: "error", message: "Agent not wired up yet" }),
        )
        break
      }
      case "interrupt": {
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
