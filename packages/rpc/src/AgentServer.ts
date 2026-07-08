import { Agent } from "@roop/core/Agent.ts"
import { SessionLog } from "@roop/core/SessionLog.ts"
import { SessionSearch } from "@roop/core/SessionSearch.ts"
import { Effect, Stream } from "effect"

import { AgentRpc } from "./AgentRpc.ts"

export const AgentServerLayer = AgentRpc.toLayer(
  Effect.gen(function* () {
    const agent = yield* Agent
    const sessions = yield* SessionLog
    const search = yield* SessionSearch

    return AgentRpc.of({
      RunPrompt: ({ prompt, sessionId, modelId, settings }) =>
        agent.runPrompt({
          prompt,
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(modelId !== undefined ? { modelId } : {}),
          ...(settings !== undefined ? { settings } : {}),
        }),
      Interrupt: ({ runId }) => agent.interrupt(runId),
      ListCapabilities: () => agent.listCapabilities(),
      // Subagent children stay out of the list (still Get/Subscribe by id).
      ListSessions: () =>
        Stream.fromIterableEffect(
          sessions
            .list()
            .pipe(Effect.map((list) => list.filter((session) => session.kind !== "subagent"))),
        ),
      GetSession: ({ sessionId }) => sessions.get(sessionId),
      SearchSessions: ({ query }) => Stream.fromIterableEffect(search.search(query)),
      SubscribeSession: ({ sessionId, afterRecordId }) =>
        sessions.subscribe({
          sessionId,
          ...(afterRecordId !== undefined ? { afterRecordId } : {}),
        }),
    })
  }),
)
