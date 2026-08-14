import { Agent } from "@roop/agent/Agent.ts"
import { Effect } from "effect"

import { AgentRpc } from "./AgentRpc.ts"

export const AgentRpcServer = AgentRpc.toLayer(
  Effect.gen(function* () {
    const agent = yield* Agent

    return AgentRpc.of({
      Capabilities: () => agent.capabilities(),
      Prompt: ({ prompt, sessionId, modelId }) =>
        agent.prompt({
          prompt,
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(modelId !== undefined ? { modelId } : {}),
        }),
      Interrupt: ({ sessionId }) => agent.interrupt(sessionId),
      GetHistory: ({ sessionId }) => agent.history(sessionId),
    })
  }),
)
