import type { Prompt } from "effect/unstable/ai"

/** The immutable context used when an agent renders one logical request. */
export interface AgentContext {
  readonly sessionId: string
  readonly runId: string
  readonly turn: number
  readonly step: number
  readonly history: Prompt.Prompt
}
