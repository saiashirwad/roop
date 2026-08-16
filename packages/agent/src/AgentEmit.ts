import { Context, type Effect } from "effect"

import type { AgentEvent } from "./AgentEvent.ts"

export class AgentEmit extends Context.Service<
  AgentEmit,
  {
    readonly emit: (event: AgentEvent) => Effect.Effect<void>
    /** Set while a tool handler is executing to correlate nested subagents. */
    readonly toolCallId?: string | undefined
  }
>()("roop/AgentEmit") {}
