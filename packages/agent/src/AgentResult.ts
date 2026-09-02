import { Option } from "effect"

import { RunId, SessionId } from "./DomainIds.ts"
import {
  emptyUsage,
  type FinishReason,
  type ToolCallEvent,
  type ToolResultEvent,
  type Usage,
} from "./Event.ts"
import type { RunEvent } from "./RunEvent.ts"

/** The folded outcome of one run, as `Agent.run` returns it. */
export interface AgentResult {
  readonly sessionId: SessionId
  readonly runId: RunId
  /** The assistant text of the run, folded from `text/delta`. */
  readonly text: string
  /** The assistant reasoning of the run, folded from `reasoning/delta`. */
  readonly reasoning: string
  readonly finishReason: FinishReason
  readonly usage: Usage
  /** The run's own tool calls; child runs' calls arrive wrapped in `subagent` and are not here. */
  readonly toolCalls: ReadonlyArray<ToolCallEvent>
  readonly toolResults: ReadonlyArray<ToolResultEvent>
}

/** The running fold of a run's events: an `AgentResult` without the run's identity. */
export type Fold = Omit<AgentResult, "sessionId" | "runId">

export const emptyFold: Fold = {
  text: "",
  reasoning: "",
  finishReason: "completed",
  usage: emptyUsage,
  toolCalls: [],
  toolResults: [],
}

/** Fold one more event of the run. Pure; the runtime folds live and `fromEvents` folds a batch. */
export const foldEvent = (fold: Fold, event: RunEvent): Fold => {
  switch (event._tag) {
    case "run":
      return event.state === "completed" || event.state === "aborted"
        ? {
            ...fold,
            finishReason: event.reason ?? fold.finishReason,
            usage: event.usage ?? fold.usage,
          }
        : fold
    case "text/delta":
      return { ...fold, text: fold.text + event.delta }
    case "reasoning/delta":
      return { ...fold, reasoning: fold.reasoning + event.delta }
    case "tool/call":
      return { ...fold, toolCalls: [...fold.toolCalls, event] }
    case "tool/result":
      return { ...fold, toolResults: [...fold.toolResults, event] }
    default:
      return fold
  }
}

/** Attach the run's identity to a finished fold. */
export const fromFold = (sessionId: SessionId, runId: RunId, fold: Fold): AgentResult => ({
  sessionId,
  runId,
  ...fold,
})

/**
 * Fold the events of one run into an `AgentResult`. The run's identity and
 * finish reason come from its top-level `run` events, so the result is
 * `None` when the events hold no `run` event.
 */
export const fromEvents = (events: ReadonlyArray<RunEvent>): Option.Option<AgentResult> => {
  let identity: Option.Option<{ readonly sessionId: SessionId; readonly runId: RunId }> =
    Option.none()
  let fold = emptyFold
  for (const event of events) {
    if (event._tag === "run" && Option.isNone(identity)) {
      identity = Option.some({
        sessionId: SessionId.make(event.sessionId),
        runId: RunId.make(event.runId),
      })
    }
    fold = foldEvent(fold, event)
  }
  return Option.map(identity, ({ sessionId, runId }) => fromFold(sessionId, runId, fold))
}
