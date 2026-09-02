import { Effect, type Scope, Stream } from "effect"

import type { AgentDefinition } from "./Agent.ts"
import type { AgentResult } from "./AgentResult.ts"
import { type RunId, SessionId } from "./DomainIds.ts"
import type { Middleware } from "./Middleware.ts"
import { isTextDelta } from "./RunEvent.ts"
import type { RunPolicy } from "./RunPolicy.ts"
import {
  runAgent,
  type RunHandle,
  type RuntimeError,
  type RuntimeServices,
  type RuntimeStream,
  type SessionMeta,
  startAgent,
  type StartError,
} from "./Runtime.ts"

export interface SessionRunOptions<RM = never, EM = never> {
  readonly runId?: RunId | string | undefined
  readonly policy?: RunPolicy | undefined
  readonly middleware?: Middleware<RM, EM> | undefined
  readonly meta?: SessionMeta | undefined
}

/** An agent bound to a session id. It does no I/O; each call reloads history from the journal. */
export interface AgentSession<out R = never, out E = never> {
  readonly id: SessionId

  /** Start a run in the current scope and return its handle. */
  readonly start: <RM = never, EM = never>(
    prompt: string,
    options?: SessionRunOptions<RM, EM>,
  ) => Effect.Effect<RunHandle<E | EM>, StartError, RuntimeServices<R | RM> | Scope.Scope>

  /** Run to completion and return the folded result. */
  readonly run: <RM = never, EM = never>(
    prompt: string,
    options?: SessionRunOptions<RM, EM>,
  ) => Effect.Effect<AgentResult, RuntimeError<E | EM>, RuntimeServices<R | RM>>

  readonly events: <RM = never, EM = never>(
    prompt: string,
    options?: SessionRunOptions<RM, EM>,
  ) => RuntimeStream<R | RM, E | EM>

  readonly streamText: <RM = never, EM = never>(
    prompt: string,
    options?: SessionRunOptions<RM, EM>,
  ) => Stream.Stream<string, RuntimeError<E | EM>, RuntimeServices<R | RM>>
}

export const session = <R = never, E = never>(
  agent: AgentDefinition<R, E>,
  sessionId: SessionId | string,
): AgentSession<R, E> => {
  const id = SessionId.make(sessionId)

  const start = <RM = never, EM = never>(prompt: string, options?: SessionRunOptions<RM, EM>) =>
    startAgent(agent, { ...options, sessionId: id, prompt })

  const events = <RM = never, EM = never>(prompt: string, options?: SessionRunOptions<RM, EM>) =>
    runAgent(agent, { ...options, sessionId: id, prompt })

  return {
    id,
    start,
    events,
    run: (prompt, options) =>
      Effect.scoped(Effect.flatMap(start(prompt, options), (handle) => handle.result)),
    streamText: (prompt, options) =>
      events(prompt, options).pipe(
        Stream.filter(isTextDelta),
        Stream.map((event) => event.delta),
      ),
  }
}
