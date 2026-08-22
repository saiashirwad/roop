import type { AgentEvent } from "./AgentEvents.ts"
import type { RunId, SessionId } from "./DomainIds.ts"

export interface ToolCallSummary {
  readonly id: string
  readonly name: string
  readonly params: unknown
  readonly providerExecuted?: boolean | undefined
}

export interface ToolResultSummary {
  readonly id: string
  readonly name: string
  readonly isFailure: boolean
  readonly result: unknown
  readonly providerExecuted?: boolean | undefined
}

export interface AgentResult {
  readonly sessionId: SessionId
  readonly runId: RunId
  readonly text: string
  readonly reasoning: string
  readonly finishReason: "completed" | "failed" | "interrupted" | "stopped"
  readonly toolCalls: ReadonlyArray<ToolCallSummary>
  readonly toolResults: ReadonlyArray<ToolResultSummary>
}

/** Fold a list of AgentEvent values into an AgentResult. */
export const fromEvents = (
  sessionId: SessionId,
  runId: RunId,
  events: ReadonlyArray<AgentEvent>,
): AgentResult => {
  let text = ""
  let reasoning = ""
  let finishReason: "completed" | "failed" | "interrupted" | "stopped" = "completed"
  const toolCalls: Array<ToolCallSummary> = []
  const toolResults: Array<ToolResultSummary> = []

  for (const event of events) {
    switch (event._tag) {
      case "TextDelta":
        text += event.delta
        break
      case "ReasoningDelta":
        reasoning += event.delta
        break
      case "ToolCall":
        toolCalls.push({
          id: event.id,
          name: event.name,
          params: event.params,
          ...(event.providerExecuted === undefined
            ? undefined
            : { providerExecuted: event.providerExecuted }),
        })
        break
      case "ToolResult":
        toolResults.push({
          id: event.id,
          name: event.name,
          isFailure: event.isFailure,
          result: event.result,
          ...(event.providerExecuted === undefined
            ? undefined
            : { providerExecuted: event.providerExecuted }),
        })
        break
      case "Finish":
        finishReason = event.reason
        break
      case "Subagent":
        break
    }
  }

  return {
    sessionId,
    runId,
    text,
    reasoning,
    finishReason,
    toolCalls,
    toolResults,
  }
}
