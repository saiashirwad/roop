import { Context, Schema, type Effect } from "effect"

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
