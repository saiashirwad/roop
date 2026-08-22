import { Context } from "effect"

import type { RunId, SessionId } from "./DomainIds.ts"

/** Payload provided to every tool execution by the Roop runtime. */
export interface ToolExecutionContextService {
  readonly sessionId: SessionId
  readonly runId: RunId
  readonly turn: number
  readonly step: number
  readonly callId: string
}

export class ToolExecutionContext extends Context.Service<
  ToolExecutionContext,
  ToolExecutionContextService
>()("roop/ToolExecutionContext") {}

export type ToolExecutionContextPayload = ToolExecutionContextService
