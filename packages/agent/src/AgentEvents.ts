import { Context, Schema, type Effect } from "effect"

export { AssistantContentPart, EVENT_VERSION, JournalEvent, LiveEvent } from "./Event.ts"

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

/** The live events of one run, as consumers see them. */
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

/** Lets a tool handler publish events into the run that is executing it. */
export class AgentEmit extends Context.Service<
  AgentEmit,
  {
    readonly emit: (event: AgentEvent) => Effect.Effect<void>
    readonly toolCallId?: string | undefined
  }
>()("roop/AgentEmit") {}
