import { Schema } from "effect"

/** The durable event format version used by the experimental kernel. */
export const EVENT_VERSION = 1 as const
export const EventVersion = Schema.Literal(EVENT_VERSION)

/** A JSON value. Functions, handlers, and live streams never enter this type. */
export type Json = Schema.Json
export const Json = Schema.Json

export const LifecycleState = Schema.Literals(["started", "completed", "aborted", "recovered"])
export type LifecycleState = typeof LifecycleState.Type

export const FinishReason = Schema.Literals(["completed", "failed", "interrupted", "stopped"])
export type FinishReason = typeof FinishReason.Type

export const AssistantContentPart = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("reasoning"), text: Schema.String }),
])
export type AssistantContentPart = typeof AssistantContentPart.Type

const base = { version: EventVersion }

/** Lifecycle records for one runtime-owned run. */
export const RunEvent = Schema.TaggedStruct("run", {
  ...base,
  sessionId: Schema.String,
  runId: Schema.String,
  state: LifecycleState,
  reason: Schema.optionalKey(FinishReason),
  message: Schema.optionalKey(Schema.String),
})
export type RunEvent = typeof RunEvent.Type

/** Lifecycle records for a logical turn. */
export const TurnEvent = Schema.TaggedStruct("turn", {
  ...base,
  runId: Schema.String,
  turn: Schema.Finite,
  state: LifecycleState,
  reason: Schema.optionalKey(FinishReason),
  message: Schema.optionalKey(Schema.String),
})
export type TurnEvent = typeof TurnEvent.Type

/** Lifecycle records for one interpreter step. */
export const StepEvent = Schema.TaggedStruct("step", {
  ...base,
  runId: Schema.String,
  turn: Schema.Finite,
  step: Schema.Finite,
  state: LifecycleState,
  reason: Schema.optionalKey(FinishReason),
  message: Schema.optionalKey(Schema.String),
})
export type StepEvent = typeof StepEvent.Type

/** Records each physical model attempt under one immutable logical request. */
export const ModelAttemptEvent = Schema.TaggedStruct("model/attempt", {
  ...base,
  runId: Schema.String,
  turn: Schema.Finite,
  step: Schema.Finite,
  attempt: Schema.Finite,
  requestId: Schema.String,
  state: LifecycleState,
  error: Schema.optionalKey(Json),
  message: Schema.optionalKey(Schema.String),
})
export type ModelAttemptEvent = typeof ModelAttemptEvent.Type

/** The effective model request. It is JSON-safe and records one logical request. */
export const ModelRequestEvent = Schema.TaggedStruct("model/request", {
  ...base,
  runId: Schema.String,
  turn: Schema.Finite,
  step: Schema.Finite,
  requestId: Schema.String,
  request: Json,
  planFingerprint: Schema.String,
  promptFingerprint: Schema.String,
  toolFingerprint: Schema.String,
  toolNames: Schema.Array(Schema.String),
})
export type ModelRequestEvent = typeof ModelRequestEvent.Type

/** A complete assistant message. Token deltas are live-only and are not here. */
export const AssistantMessageEvent = Schema.TaggedStruct("assistant/message", {
  ...base,
  parts: Schema.Array(AssistantContentPart),
})
export type AssistantMessageEvent = typeof AssistantMessageEvent.Type

export const SystemMessageEvent = Schema.TaggedStruct("system/message", {
  ...base,
  content: Schema.String,
})
export type SystemMessageEvent = typeof SystemMessageEvent.Type

export const UserMessageEvent = Schema.TaggedStruct("user/message", {
  ...base,
  content: Schema.String,
})
export type UserMessageEvent = typeof UserMessageEvent.Type

/**
 * Session metadata for session lists. The latest value of each field wins,
 * so a later event that sets only `title` keeps an earlier `cwd`.
 */
export const SessionMetaEvent = Schema.TaggedStruct("session/meta", {
  ...base,
  title: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
})
export type SessionMetaEvent = typeof SessionMetaEvent.Type

/** A model-issued tool call, including provider-executed calls. */
export const ToolCallEvent = Schema.TaggedStruct("tool/call", {
  ...base,
  runId: Schema.optionalKey(Schema.String),
  turn: Schema.optionalKey(Schema.Finite),
  step: Schema.optionalKey(Schema.Finite),
  id: Schema.String,
  name: Schema.String,
  params: Json,
  providerExecuted: Schema.optionalKey(Schema.Boolean),
})
export type ToolCallEvent = typeof ToolCallEvent.Type

/** A final tool result. `execution-unknown` is used during recovery. */
export const ToolResultEvent = Schema.TaggedStruct("tool/result", {
  ...base,
  runId: Schema.optionalKey(Schema.String),
  turn: Schema.optionalKey(Schema.Finite),
  step: Schema.optionalKey(Schema.Finite),
  id: Schema.String,
  name: Schema.String,
  isFailure: Schema.Boolean,
  result: Json,
  providerExecuted: Schema.optionalKey(Schema.Boolean),
  failureReason: Schema.optionalKey(Schema.String),
})
export type ToolResultEvent = typeof ToolResultEvent.Type

/** Lifecycle records for a tool dispatch. */
export const ToolEvent = Schema.TaggedStruct("tool", {
  ...base,
  runId: Schema.String,
  turn: Schema.Finite,
  step: Schema.Finite,
  id: Schema.String,
  name: Schema.String,
  state: LifecycleState,
  isFailure: Schema.optionalKey(Schema.Boolean),
  result: Schema.optionalKey(Json),
  failureReason: Schema.optionalKey(Schema.String),
})
export type ToolEvent = typeof ToolEvent.Type

/** All semantic events written to a Journal. */
export const JournalEvent = Schema.Union([
  RunEvent,
  TurnEvent,
  StepEvent,
  ModelAttemptEvent,
  ModelRequestEvent,
  SessionMetaEvent,
  SystemMessageEvent,
  UserMessageEvent,
  AssistantMessageEvent,
  ToolEvent,
  ToolCallEvent,
  ToolResultEvent,
])
export type JournalEvent = typeof JournalEvent.Type

/** Live token and reasoning deltas are intentionally not members of JournalEvent. */
export const TextDelta = Schema.TaggedStruct("TextDelta", {
  version: EventVersion,
  delta: Schema.String,
})
export const ReasoningDelta = Schema.TaggedStruct("ReasoningDelta", {
  version: EventVersion,
  delta: Schema.String,
})
export const LiveEvent = Schema.Union([
  TextDelta,
  ReasoningDelta,
  ToolCallEvent,
  ToolResultEvent,
  RunEvent,
  TurnEvent,
  StepEvent,
  ModelAttemptEvent,
  ModelRequestEvent,
  SessionMetaEvent,
  SystemMessageEvent,
  UserMessageEvent,
  AssistantMessageEvent,
  ToolEvent,
])
export type LiveEvent = typeof LiveEvent.Type

/** Decode one event from a JSON boundary and reject future versions. */
export const decodeJournalEvent = Schema.decodeEffect(JournalEvent)
export const encodeJournalEvent = Schema.encodeEffect(JournalEvent)

export const isJournalEvent = Schema.is(JournalEvent)
