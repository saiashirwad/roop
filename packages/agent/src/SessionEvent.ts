import { Schema } from "effect"
import { Prompt } from "effect/unstable/ai"

/**
 * Monotonic format version stamped on every session log header. Loaders reject
 * logs with an unknown (newer) version instead of silently misreading them.
 * Version 2 added `step/*` markers and the model-facing request record; version
 * 1 logs remain readable because every v1 event tag still decodes against the
 * current union.
 */
export const SESSION_FORMAT_VERSION = 2

export const SessionHeader = Schema.Struct({
  version: Schema.Finite,
  createdAt: Schema.Finite,
})

export type SessionHeader = typeof SessionHeader.Type

/** Completed text/reasoning content of an assistant turn, as the model produced it. */
export const AssistantContentPart = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("reasoning"), text: Schema.String }),
])

export type AssistantContentPart = typeof AssistantContentPart.Type

export const SessionEvent = Schema.Union([
  Schema.TaggedStruct("system/message", {
    content: Schema.String,
  }),
  Schema.TaggedStruct("user/message", {
    content: Schema.String,
  }),
  Schema.TaggedStruct("assistant/message", {
    parts: Schema.Array(AssistantContentPart),
  }),
  Schema.TaggedStruct("tool/call", {
    id: Schema.String,
    name: Schema.String,
    params: Schema.Unknown,
    // Optional for backwards compatibility with v1 logs.
    providerExecuted: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.TaggedStruct("tool/result", {
    id: Schema.String,
    name: Schema.String,
    isFailure: Schema.Boolean,
    result: Schema.Unknown,
    // Optional for backwards compatibility with v1 logs.
    providerExecuted: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.TaggedStruct("turn/start", {}),
  Schema.TaggedStruct("turn/end", {
    reason: Schema.Literals(["completed", "failed", "interrupted", "stopped"]),
    message: Schema.optionalKey(Schema.String),
  }),
  Schema.TaggedStruct("step/start", {
    index: Schema.Finite,
  }),
  Schema.TaggedStruct("model/request", {
    request: Schema.Unknown,
  }),
  Schema.TaggedStruct("step/end", {
    reason: Schema.Literals(["completed", "failed", "interrupted"]),
    message: Schema.optionalKey(Schema.String),
  }),
])

export type SessionEvent = typeof SessionEvent.Type

type AssistantPart = Prompt.AssistantMessagePart
type ToolPart = Prompt.ToolMessagePart

/**
 * Project the durable event log into the `Prompt.Message[]` a model consumes.
 *
 * An `assistant/message` event and its consecutive `tool/call`s coalesce into
 * a single assistant message (the DeepSeek API rejects consecutive tool-call
 * messages — see the `@effect__ai-openai-compat` patch note in AGENTS.md),
 * with the matching results in a following tool message. Trailing tool calls
 * without results (an interrupted turn) are dropped so the projection never
 * ends mid-tool-round-trip.
 */
export const deriveMessages = (
  events: ReadonlyArray<SessionEvent>,
): ReadonlyArray<Prompt.Message> => {
  const messages: Array<Prompt.Message> = []
  let assistantParts: Array<AssistantPart> = []
  let toolParts: Array<ToolPart> = []

  const flushTool = () => {
    if (toolParts.length === 0) return
    messages.push(Prompt.makeMessage("tool", { content: toolParts }))
    toolParts = []
  }

  const flushAssistant = () => {
    if (assistantParts.length === 0) return
    messages.push(Prompt.makeMessage("assistant", { content: assistantParts }))
    assistantParts = []
  }

  const flushAll = () => {
    flushTool()
    // Dangling tool calls have no result to answer them; drop the parts.
    assistantParts = assistantParts.filter((part) => part.type !== "tool-call")
    flushAssistant()
  }

  for (const event of events) {
    switch (event._tag) {
      case "system/message": {
        flushAll()
        messages.push(Prompt.makeMessage("system", { content: event.content }))
        break
      }
      case "user/message": {
        flushAll()
        messages.push(
          Prompt.makeMessage("user", {
            content: [Prompt.makePart("text", { text: event.content })],
          }),
        )
        break
      }
      case "assistant/message": {
        flushTool()
        for (const part of event.parts) {
          assistantParts.push(Prompt.makePart(part.type, { text: part.text }))
        }
        break
      }
      case "tool/call": {
        assistantParts.push(
          Prompt.makePart("tool-call", {
            id: event.id,
            name: event.name,
            params: event.params,
            providerExecuted: event.providerExecuted ?? false,
          }),
        )
        break
      }
      case "tool/result": {
        flushAssistant()
        toolParts.push(
          Prompt.makePart("tool-result", {
            id: event.id,
            name: event.name,
            isFailure: event.isFailure,
            result: event.result,
          }),
        )
        break
      }
      case "turn/start":
      case "turn/end":
      case "step/start":
      case "model/request":
      case "step/end": {
        break
      }
    }
  }

  flushAll()
  return messages
}
