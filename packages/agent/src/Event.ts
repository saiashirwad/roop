import { Schema } from "effect"

/**
 * The durable event format version. It names the schema shape of a stored
 * record: a reader that understands version N rejects records with a higher
 * version (`JournalFutureVersion`) and cannot decode records with a lower
 * one. Version 2 added `at` to every event and usage, finish reason, and
 * model identity to `model/attempt`, `step`, and `run`.
 */
export const EVENT_VERSION = 2 as const
export const EventVersion = Schema.Literal(EVENT_VERSION)

/** A JSON value. Functions, handlers, and live streams never enter this type. */
export type Json = Schema.Json
export const Json = Schema.Json

export const LifecycleState = Schema.Literals(["started", "completed", "aborted", "recovered"])
export type LifecycleState = typeof LifecycleState.Type

/** Why a runtime span (run, turn, step) ended. */
export const FinishReason = Schema.Literals(["completed", "failed", "interrupted", "stopped"])
export type FinishReason = typeof FinishReason.Type

/** Why the model stopped generating, as normalized by Effect AI. */
export const ModelFinishReason = Schema.Literals([
  "stop",
  "length",
  "content-filter",
  "tool-calls",
  "error",
  "pause",
  "other",
  "unknown",
])
export type ModelFinishReason = typeof ModelFinishReason.Type

/**
 * Provider-agnostic token usage. `totalTokens` is input plus output. The
 * optional counts are subsets of the input and output totals and are only
 * present when the provider reported them.
 */
export const Usage = Schema.Struct({
  inputTokens: Schema.Finite,
  outputTokens: Schema.Finite,
  totalTokens: Schema.Finite,
  cachedInputTokens: Schema.optionalKey(Schema.Finite),
  reasoningTokens: Schema.optionalKey(Schema.Finite),
})
export type Usage = typeof Usage.Type

export const emptyUsage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }

const addOptional = (left: number | undefined, right: number | undefined) =>
  left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0)

/** Sum two usage records. An optional count is present when either side reports it. */
export const addUsage = (left: Usage, right: Usage): Usage => {
  const cachedInputTokens = addOptional(left.cachedInputTokens, right.cachedInputTokens)
  const reasoningTokens = addOptional(left.reasoningTokens, right.reasoningTokens)
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    ...(cachedInputTokens === undefined ? undefined : { cachedInputTokens }),
    ...(reasoningTokens === undefined ? undefined : { reasoningTokens }),
  }
}

export const AssistantContentPart = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("reasoning"), text: Schema.String }),
])
export type AssistantContentPart = typeof AssistantContentPart.Type

/** Every event carries the format version and `at`, epoch milliseconds from the runtime `Clock`. */
const base = { version: EventVersion, at: Schema.Finite }

/** Lifecycle records for one runtime-owned run. Terminal events carry the run's total usage. */
export const RunLifecycleEvent = Schema.TaggedStruct("run", {
  ...base,
  sessionId: Schema.String,
  runId: Schema.String,
  state: LifecycleState,
  reason: Schema.optionalKey(FinishReason),
  message: Schema.optionalKey(Schema.String),
  usage: Schema.optionalKey(Usage),
})
export type RunLifecycleEvent = typeof RunLifecycleEvent.Type

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

/** Lifecycle records for one interpreter step. Terminal events carry the step's usage. */
export const StepEvent = Schema.TaggedStruct("step", {
  ...base,
  runId: Schema.String,
  turn: Schema.Finite,
  step: Schema.Finite,
  state: LifecycleState,
  reason: Schema.optionalKey(FinishReason),
  message: Schema.optionalKey(Schema.String),
  usage: Schema.optionalKey(Usage),
})
export type StepEvent = typeof StepEvent.Type

/**
 * Records each physical model attempt under one immutable logical request.
 * A completed attempt carries what the provider reported at the end of its
 * stream: `usage`, `finishReason`, and the `model` that answered.
 */
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
  usage: Schema.optionalKey(Usage),
  finishReason: Schema.optionalKey(ModelFinishReason),
  model: Schema.optionalKey(Schema.String),
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

/**
 * What a run asks the user. An approval gates one tool call, identified by
 * its `toolCallId`; a question comes from a tool handler (`ask_user`) and may
 * offer choices. The request is the client's whole rendering input.
 */
export const ApprovalRequest = Schema.Struct({
  kind: Schema.Literal("approval"),
  toolCallId: Schema.String,
  name: Schema.String,
  params: Json,
  reason: Schema.optionalKey(Schema.String),
})
export type ApprovalRequest = typeof ApprovalRequest.Type

export const QuestionRequest = Schema.Struct({
  kind: Schema.Literal("question"),
  question: Schema.String,
  choices: Schema.optionalKey(Schema.Array(Schema.String)),
})
export type QuestionRequest = typeof QuestionRequest.Type

export const InteractionRequest = Schema.Union([ApprovalRequest, QuestionRequest])
export type InteractionRequest = typeof InteractionRequest.Type

export const InteractionKind = Schema.Literals(["approval", "question"])
export type InteractionKind = typeof InteractionKind.Type

/**
 * The user's answer. An approval response carries the decision and an
 * optional message the model sees as the denied call's result; a question
 * response carries the answer text.
 */
export const ApprovalResponse = Schema.Struct({
  kind: Schema.Literal("approval"),
  decision: Schema.Literals(["allow", "deny"]),
  message: Schema.optionalKey(Schema.String),
})
export type ApprovalResponse = typeof ApprovalResponse.Type

export const QuestionResponse = Schema.Struct({
  kind: Schema.Literal("question"),
  answer: Schema.String,
})
export type QuestionResponse = typeof QuestionResponse.Type

export const InteractionResponse = Schema.Union([ApprovalResponse, QuestionResponse])
export type InteractionResponse = typeof InteractionResponse.Type

/** The response type that answers a request of the same kind. */
export type ResponseFor<R extends InteractionRequest> = Extract<
  InteractionResponse,
  { readonly kind: R["kind"] }
>

/**
 * The run is waiting on the user. `id` names the interaction for the
 * response; an approval's id is its tool call id. The run stays parked until
 * an `interaction/responded` with the same id is committed.
 */
export const InteractionRequestedEvent = Schema.TaggedStruct("interaction/requested", {
  ...base,
  runId: Schema.String,
  turn: Schema.Finite,
  step: Schema.Finite,
  id: Schema.String,
  request: InteractionRequest,
})
export type InteractionRequestedEvent = typeof InteractionRequestedEvent.Type

/**
 * The user answered, or the runtime closed the request. `message` is the
 * runtime's note when it synthesized the response (a run that ended while
 * parked); a user's own message travels inside `response`.
 */
export const InteractionRespondedEvent = Schema.TaggedStruct("interaction/responded", {
  ...base,
  runId: Schema.String,
  turn: Schema.Finite,
  step: Schema.Finite,
  id: Schema.String,
  response: InteractionResponse,
  message: Schema.optionalKey(Schema.String),
})
export type InteractionRespondedEvent = typeof InteractionRespondedEvent.Type

/** All semantic events written to a Journal. */
export const JournalEvent = Schema.Union([
  RunLifecycleEvent,
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
  InteractionRequestedEvent,
  InteractionRespondedEvent,
])
export type JournalEvent = typeof JournalEvent.Type

/**
 * An event before the runtime stamps it. `at` is assigned when a journal
 * event is committed or a live event is published, so producers never
 * choose timestamps and fingerprints never include them.
 */
export type Unstamped<E> = E extends { readonly at: number } ? Omit<E, "at"> : never

export const stampJournalEvent = (event: Unstamped<JournalEvent>, at: number): JournalEvent => ({
  ...event,
  at,
})

/** Decode one event from a JSON boundary and reject future versions. */
export const decodeJournalEvent = Schema.decodeEffect(JournalEvent)
export const encodeJournalEvent = Schema.encodeEffect(JournalEvent)

export const isJournalEvent = Schema.is(JournalEvent)
