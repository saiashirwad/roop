import type { Prompt } from "effect/unstable/ai"

import type { RunId, SessionId } from "./DomainIds.ts"

/** The immutable context used when an agent renders one logical request. */
export interface AgentContext {
  readonly sessionId: SessionId
  readonly runId: RunId
  readonly turn: number
  readonly step: number
  readonly history: Prompt.Prompt
}
