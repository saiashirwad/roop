import { Schema } from "effect"

/** Domain-neutral run stream events. Tool payloads are opaque to core. */
export const AgentEventSchema = Schema.Union([
  Schema.TaggedStruct("RunStarted", {
    runId: Schema.String,
    sessionId: Schema.String,
  }),
  Schema.TaggedStruct("ReasoningDelta", {
    delta: Schema.String,
  }),
  Schema.TaggedStruct("TextDelta", {
    delta: Schema.String,
  }),
  Schema.TaggedStruct("ToolCall", {
    id: Schema.String,
    name: Schema.String,
    params: Schema.Unknown,
  }),
  /** Intermediate tool output from Toolkit `context.preliminary`. */
  Schema.TaggedStruct("ToolProgress", {
    id: Schema.String,
    name: Schema.String,
    result: Schema.Unknown,
  }),
  Schema.TaggedStruct("ToolResult", {
    id: Schema.String,
    name: Schema.String,
    isFailure: Schema.Boolean,
    result: Schema.Unknown,
  }),
  Schema.TaggedStruct("SubagentStarted", {
    parentToolCallId: Schema.String,
    agentId: Schema.String,
    childSessionId: Schema.String,
    childRunId: Schema.String,
  }),
  Schema.TaggedStruct("SubagentCompleted", {
    parentToolCallId: Schema.String,
    agentId: Schema.String,
    childSessionId: Schema.String,
    childRunId: Schema.String,
    status: Schema.Literals(["completed", "failed", "interrupted"]),
  }),
  Schema.TaggedStruct("RunCompleted", {}),
  Schema.TaggedStruct("RunFailed", {
    message: Schema.String,
  }),
  Schema.TaggedStruct("RunInterrupted", {
    runId: Schema.String,
  }),
])

export type AgentEvent = typeof AgentEventSchema.Type
