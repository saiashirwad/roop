import type { Actor, SessionRecord } from "@roop/core/SessionStore.ts"

/** Client → room messages (JSON over the room WebSocket). */
export type ClientMessage =
  | { readonly type: "prompt"; readonly text: string }
  | { readonly type: "interrupt" }

/** Room → client messages (JSON over the room WebSocket). */
export type ServerMessage =
  | {
      readonly type: "welcome"
      readonly self: Actor
      readonly members: ReadonlyArray<Actor>
      readonly cursor: number
      readonly running: boolean
    }
  | { readonly type: "presence"; readonly members: ReadonlyArray<Actor> }
  | { readonly type: "record"; readonly seq: number; readonly record: SessionRecord }
  | { readonly type: "error"; readonly message: string }

export const encodeServerMessage = (message: ServerMessage): string => JSON.stringify(message)

/** Parse an incoming client frame; returns undefined for anything malformed. */
export const decodeClientMessage = (raw: unknown): ClientMessage | undefined => {
  if (typeof raw !== "string") return undefined
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  const message = value as { type?: unknown; text?: unknown }
  if (message.type === "prompt" && typeof message.text === "string" && message.text.length > 0) {
    return { type: "prompt", text: message.text }
  }
  if (message.type === "interrupt") {
    return { type: "interrupt" }
  }
  return undefined
}
