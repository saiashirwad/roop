import { Context, type Effect, Schema } from "effect"

import { EventVersion, JournalEvent, Json, type Unstamped } from "./Event.ts"

/*
 * The live event algebra of one run. A consumer sees exactly the journal
 * events of the run, in commit order, interleaved with the live-only members
 * below. A replayed journal is rendered by the same code as the live stream.
 */

const live = { version: EventVersion, at: Schema.Finite }

/** One chunk of assistant text. Never durable: the journal keeps `assistant/message`. */
export const TextDelta = Schema.TaggedStruct("text/delta", {
  ...live,
  runId: Schema.String,
  step: Schema.Finite,
  delta: Schema.String,
})
export type TextDelta = typeof TextDelta.Type

/** One chunk of assistant reasoning. */
export const ReasoningDelta = Schema.TaggedStruct("reasoning/delta", {
  ...live,
  runId: Schema.String,
  step: Schema.Finite,
  delta: Schema.String,
})
export type ReasoningDelta = typeof ReasoningDelta.Type

/**
 * A preliminary output of a running tool call: a streamed partial result or a
 * progress value a handler published. The final result lands as `tool/result`.
 */
export const ToolOutput = Schema.TaggedStruct("tool/output", {
  ...live,
  runId: Schema.String,
  step: Schema.Finite,
  id: Schema.String,
  name: Schema.String,
  output: Json,
})
export type ToolOutput = typeof ToolOutput.Type

/** One event of a child run, forwarded by the tool call that runs the child. */
export interface Subagent {
  readonly _tag: "subagent"
  readonly version: typeof EventVersion.Type
  readonly at: number
  readonly name: string
  readonly toolCallId?: string
  readonly event: RunEvent
}

/** Every event a consumer can observe during a run. */
export type RunEvent = JournalEvent | TextDelta | ReasoningDelta | ToolOutput | Subagent

export const Subagent = Schema.TaggedStruct("subagent", {
  ...live,
  name: Schema.String,
  toolCallId: Schema.optionalKey(Schema.String),
  event: Schema.suspend((): Schema.Codec<RunEvent> => RunEvent),
})

export const RunEvent: Schema.Codec<RunEvent> = Schema.Union([
  JournalEvent,
  TextDelta,
  ReasoningDelta,
  ToolOutput,
  Subagent,
])

/** The members of `RunEvent` that are never written to a journal. */
export type LiveEvent = TextDelta | ReasoningDelta | ToolOutput | Subagent

export const LiveEvent: Schema.Codec<LiveEvent> = Schema.Union([
  TextDelta,
  ReasoningDelta,
  ToolOutput,
  Subagent,
])

export const isLive = (event: RunEvent): event is LiveEvent => {
  switch (event._tag) {
    case "text/delta":
    case "reasoning/delta":
    case "tool/output":
    case "subagent":
      return true
    default:
      return false
  }
}

/** A top-level `run` event that ends the run: consumers stop reading after it. */
export const isTerminal = (event: RunEvent): boolean =>
  event._tag === "run" && (event.state === "completed" || event.state === "aborted")

/** Narrow to a top-level `text/delta`; `Stream.filter(isTextDelta)` yields the text chunks. */
export const isTextDelta = (event: RunEvent): event is TextDelta => event._tag === "text/delta"

/**
 * What a tool handler may publish into the run that is executing it. Both
 * operations produce live-only events; a handler cannot write to the journal.
 */
export interface RunEmitService {
  /** Publish a preliminary `tool/output` for the executing tool call. */
  readonly output: (output: Json) => Effect.Effect<void>
  /** Forward one event of a child run, wrapped as `subagent` for this tool call. */
  readonly subagent: (name: string, event: RunEvent) => Effect.Effect<void>
}

export class RunEmit extends Context.Service<RunEmit, RunEmitService>()("roop/RunEmit") {}

/** A live event before the runtime stamps `at`. */
export type UnstampedLiveEvent = Unstamped<LiveEvent>

export const stampLiveEvent = (event: UnstampedLiveEvent, at: number): LiveEvent => ({
  ...event,
  at,
})
