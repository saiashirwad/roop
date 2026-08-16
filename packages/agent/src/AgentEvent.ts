import { Schema } from "effect"

const TextDelta = Schema.TaggedStruct("TextDelta", {
  delta: Schema.String,
})

const ReasoningDelta = Schema.TaggedStruct("ReasoningDelta", {
  delta: Schema.String,
})

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
  /** Stable id of the parent delegation tool call. */
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
