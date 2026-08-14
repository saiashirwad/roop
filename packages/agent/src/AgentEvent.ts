import { Schema } from "effect"

export const AgentEvent = Schema.Union([
  Schema.TaggedStruct("TextDelta", {
    delta: Schema.String,
  }),
  Schema.TaggedStruct("ReasoningDelta", {
    delta: Schema.String,
  }),
  Schema.TaggedStruct("ToolCall", {
    id: Schema.String,
    name: Schema.String,
    params: Schema.Unknown,
  }),
  Schema.TaggedStruct("ToolResult", {
    id: Schema.String,
    name: Schema.String,
    isFailure: Schema.Boolean,
    result: Schema.Unknown,
  }),
  Schema.TaggedStruct("Finish", {
    reason: Schema.Literals(["completed", "failed", "interrupted"]),
    message: Schema.optionalKey(Schema.String),
  }),
])

export type AgentEvent = typeof AgentEvent.Type
