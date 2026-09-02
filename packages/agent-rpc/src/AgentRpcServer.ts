import type { Agent as AgentModule } from "@roop/agent"
import { Effect, Layer } from "effect"

import { AgentRpc } from "./AgentRpc.ts"
import { RunSupervisor, RunSupervisorLive } from "./RunSupervisor.ts"

/** RPC handlers depend only on the host supervisor capability. */
export const AgentRpcServer = AgentRpc.toLayer(
  Effect.gen(function* () {
    const supervisor = yield* RunSupervisor

    return AgentRpc.of({
      StartRun: (request) => supervisor.start(request),
      SubscribeRun: ({ sessionId }) => supervisor.subscribe(sessionId),
      InterruptRun: ({ sessionId }) => supervisor.interrupt(sessionId),
      GetHistory: ({ sessionId }) => supervisor.history(sessionId),
      ListSessions: () => supervisor.list,
      DeleteSession: ({ sessionId }) => supervisor.delete(sessionId),
    })
  }),
)

/** Build a host layer for one explicit Agent value. */
export const AgentRpcServerLive = <R = never>(agent: AgentModule.AgentDefinition<R, never>) =>
  AgentRpcServer.pipe(Layer.provide(RunSupervisorLive(agent)))
