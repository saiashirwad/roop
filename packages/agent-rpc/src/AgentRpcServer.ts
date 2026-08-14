import { Agent } from "@roop/agent/Agent.ts"
import { Effect } from "effect"

import { AgentRpc } from "./AgentRpc.ts"

export const AgentRpcServer = AgentRpc.toLayer(
  Effect.gen(function* () {
    const agent = yield* Agent

    return AgentRpc.of({
      Capabilities: () => agent.capabilities(),
      Prompt: ({ prompt, sessionId, modelId, maxTurns }) =>
        agent.prompt({
          prompt,
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(modelId !== undefined ? { modelId } : {}),
          ...(maxTurns !== undefined ? { maxTurns } : {}),
        }),
      Interrupt: ({ sessionId }) => agent.interrupt(sessionId),
      GetHistory: ({ sessionId }) => agent.history(sessionId),
      ListSessions: () => agent.sessions(),
    })
  }),
)
