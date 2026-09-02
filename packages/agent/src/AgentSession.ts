import { Effect, Stream } from "effect"

import type { AgentDefinition } from "./Agent.ts"
import type { AgentEvent } from "./AgentEvents.ts"
import { type AgentResult, fromEvents } from "./AgentResult.ts"
import { RunId, SessionId } from "./DomainIds.ts"
import type { Middleware } from "./Middleware.ts"
import type { RunPolicy } from "./RunPolicy.ts"
import { runAgent, type RuntimeStream, type SessionMeta } from "./Runtime.ts"

export interface SessionRunOptions<RM = never, EM = never> {
  readonly runId?: RunId | string | undefined
  readonly policy?: RunPolicy | undefined
  readonly middleware?: Middleware<RM, EM> | undefined
  readonly meta?: SessionMeta | undefined
}

/** An agent bound to a session id. It does no I/O; each call reloads history from the journal. */
export interface AgentSession<out R = never, out E = never> {
  readonly id: SessionId

  readonly run: <RM = never, EM = never>(
    prompt: string,
    options?: SessionRunOptions<RM, EM>,
  ) => Effect.Effect<
    AgentResult,
    Stream.Error<RuntimeStream<R | RM, E | EM>>,
    Stream.Services<RuntimeStream<R | RM, E | EM>>
  >

  readonly events: <RM = never, EM = never>(
    prompt: string,
    options?: SessionRunOptions<RM, EM>,
  ) => RuntimeStream<R | RM, E | EM>

  readonly streamText: <RM = never, EM = never>(
    prompt: string,
    options?: SessionRunOptions<RM, EM>,
  ) => Stream.Stream<
    string,
    Stream.Error<RuntimeStream<R | RM, E | EM>>,
    Stream.Services<RuntimeStream<R | RM, E | EM>>
  >
}

export const session = <R = never, E = never>(
  agent: AgentDefinition<R, E>,
  sessionId: SessionId | string,
): AgentSession<R, E> => {
  const id = SessionId.make(sessionId)

  const events = <RM = never, EM = never>(prompt: string, options?: SessionRunOptions<RM, EM>) =>
    runAgent(agent, { ...options, sessionId: id, prompt })

  return {
    id,
    events,
    run: (prompt, options) =>
      Stream.runCollect(events(prompt, options)).pipe(
        Effect.map((all: ReadonlyArray<AgentEvent>) =>
          fromEvents(id, RunId.make(options?.runId ?? `${id}:0`), all),
        ),
      ),
    streamText: (prompt, options) =>
      events(prompt, options).pipe(
        Stream.filter((event) => event._tag === "TextDelta"),
        Stream.map((event) => event.delta),
      ),
  }
}
