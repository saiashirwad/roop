import { Agent } from "@roop/agent/Agent.ts"
import { Effect } from "effect"

import { AgentRpc } from "./AgentRpc.ts"

export const AgentRpcServer = AgentRpc.toLayer(
  Effect.gen(function* () {
    const agent = yield* Agent

    return AgentRpc.of({
      Capabilities: () => agent.capabilities,
      Prompt: (options) => agent.prompt(options),
      Interrupt: ({ sessionId }) => agent.interrupt(sessionId),
      GetHistory: ({ sessionId }) => agent.history(sessionId),
      ListSessions: () => agent.sessions,
      ForkSession: ({ fromSessionId, toSessionId }) => agent.fork(fromSessionId, toSessionId),
    })
  }),
)
