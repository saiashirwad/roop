import type { Toolkit } from "effect/unstable/ai"
import type * as Tool from "effect/unstable/ai/Tool"

export type ResolvedAgentSpec = {
  readonly id: string
  readonly description: string
  readonly systemPrompt: string
  readonly toolkit: Toolkit.WithHandler<Record<string, Tool.Any>>
  readonly maxTurns: number
}
