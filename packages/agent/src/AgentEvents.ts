import { Context, Schema, type Effect } from "effect"
import { Prompt } from "effect/unstable/ai"

// U4 event contracts live in Event.ts. These re-exports keep the old event
// module usable while the runtime migration removes SessionEvent callbacks.
export {
  EVENT_VERSION,
  JournalEvent,
  LiveEvent,
  type JournalEvent as JournalEventValue,
  type LiveEvent as LiveEventValue,
} from "./Event.ts"

const TextDelta = Schema.TaggedStruct("TextDelta", { delta: Schema.String })
const ReasoningDelta = Schema.TaggedStruct("ReasoningDelta", { delta: Schema.String })
const ToolCall = Schema.TaggedStruct("ToolCall", {
  id: Schema.String,
  name: Schema.String,
  params: Schema.Unknown,
  providerExecuted: Schema.optionalKey(Schema.Boolean),
})
const ToolResult = Schema.TaggedStruct("ToolResult", {
  id: Schema.String,
  name: Schema.String,
  isFailure: Schema.Boolean,
  result: Schema.Unknown,
  providerExecuted: Schema.optionalKey(Schema.Boolean),
})
const Finish = Schema.TaggedStruct("Finish", {
  reason: Schema.Literals(["completed", "failed", "interrupted", "stopped"]),
  message: Schema.optionalKey(Schema.String),
})

export interface SubagentEvent {
  readonly _tag: "Subagent"
  readonly name: string
  readonly toolCallId?: string
  readonly event: AgentEvent
}

export type AgentEvent =
  | typeof TextDelta.Type
  | typeof ReasoningDelta.Type
  | typeof ToolCall.Type
  | typeof ToolResult.Type
  | typeof Finish.Type
  | SubagentEvent

export const AgentEvent = Schema.Union([
  TextDelta,
  ReasoningDelta,
  ToolCall,
  ToolResult,
  Finish,
  Schema.TaggedStruct("Subagent", {
    name: Schema.String,
    toolCallId: Schema.optionalKey(Schema.String),
    event: Schema.suspend((): Schema.Codec<AgentEvent> => AgentEvent),
  }),
])

export class AgentEmit extends Context.Service<
  AgentEmit,
  {
    readonly emit: (event: AgentEvent) => Effect.Effect<void>
    readonly toolCallId?: string | undefined
  }
>()("roop/AgentEmit") {}

export const SESSION_FORMAT_VERSION = 2

export const SessionHeader = Schema.Struct({
  version: Schema.Finite,
  createdAt: Schema.Finite,
})
export type SessionHeader = typeof SessionHeader.Type

export const AssistantContentPart = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("reasoning"), text: Schema.String }),
])
export type AssistantContentPart = typeof AssistantContentPart.Type

export const SessionEvent = Schema.Union([
  Schema.TaggedStruct("system/message", { content: Schema.String }),
  Schema.TaggedStruct("user/message", { content: Schema.String }),
  Schema.TaggedStruct("assistant/message", { parts: Schema.Array(AssistantContentPart) }),
  Schema.TaggedStruct("tool/call", {
    id: Schema.String,
    name: Schema.String,
    params: Schema.Unknown,
    providerExecuted: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.TaggedStruct("tool/result", {
    id: Schema.String,
    name: Schema.String,
    isFailure: Schema.Boolean,
    result: Schema.Unknown,
    providerExecuted: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.TaggedStruct("turn/start", {}),
  Schema.TaggedStruct("turn/end", {
    reason: Schema.Literals(["completed", "failed", "interrupted", "stopped"]),
    message: Schema.optionalKey(Schema.String),
  }),
  Schema.TaggedStruct("step/start", { index: Schema.Finite }),
  Schema.TaggedStruct("model/request", { request: Schema.Unknown }),
  Schema.TaggedStruct("step/end", {
    reason: Schema.Literals(["completed", "failed", "interrupted"]),
    message: Schema.optionalKey(Schema.String),
  }),
])
export type SessionEvent = typeof SessionEvent.Type

type AssistantPart = Prompt.AssistantMessagePart
type ToolPart = Prompt.ToolMessagePart

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
    assistantParts = assistantParts.filter((part) => part.type !== "tool-call")
    flushAssistant()
  }

  for (const event of events) {
    switch (event._tag) {
      case "system/message":
        flushAll()
        messages.push(Prompt.makeMessage("system", { content: event.content }))
        break
      case "user/message":
        flushAll()
        messages.push(
          Prompt.makeMessage("user", {
            content: [Prompt.makePart("text", { text: event.content })],
          }),
        )
        break
      case "assistant/message":
        flushTool()
        for (const part of event.parts)
          assistantParts.push(Prompt.makePart(part.type, { text: part.text }))
        break
      case "tool/call":
        assistantParts.push(
          Prompt.makePart("tool-call", {
            id: event.id,
            name: event.name,
            params: event.params,
            providerExecuted: event.providerExecuted ?? false,
          }),
        )
        break
      case "tool/result":
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
      case "turn/start":
      case "turn/end":
      case "step/start":
      case "model/request":
      case "step/end":
        break
    }
  }
  flushAll()
  return messages
}
