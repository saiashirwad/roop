/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-escape-hatch-assertions, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-known-value-widening -- agent session handles wrap runtime streams preserving typed effect channels. */

import { Effect, Stream } from "effect"
import type { AiError, LanguageModel } from "effect/unstable/ai"

import type { AgentDefinition } from "./Agent.ts"
import type { AgentEvent } from "./AgentEvents.ts"
import { type AgentResult, fromEvents } from "./AgentResult.ts"
import { RunId, SessionId } from "./DomainIds.ts"
import type { FinalizationError, ModelTimeout, RunError, UnsafeModelRetry } from "./Error.ts"
import type { Journal, JournalAppendError, JournalLoadError } from "./Journal.ts"
import type { Middleware } from "./Middleware.ts"
import type { RunPolicy } from "./RunPolicy.ts"
import { type AgentRuntimeRequest, runAgent } from "./Runtime.ts"
import type { InvalidToolName, ToolConflict } from "./ToolRegistry.ts"

export type AgentSessionError<E, EM = never> =
  | E
  | EM
  | AiError.AiError
  | RunError
  | JournalLoadError
  | JournalAppendError
  | FinalizationError
  | InvalidToolName
  | ToolConflict
  | UnsafeModelRetry
  | ModelTimeout

export interface SessionRunOptions<RM = never, EM = never> {
  readonly runId?: RunId | string | undefined
  readonly policy?: RunPolicy | undefined
  readonly middleware?: Middleware<RM, EM> | undefined
}

export interface AgentSession<out R = never, out E = never> {
  readonly id: SessionId

  readonly run: <RM = never, EM = never>(
    prompt: string,
    options?: SessionRunOptions<RM, EM>,
  ) => Effect.Effect<
    AgentResult,
    AgentSessionError<E, EM>,
    R | RM | LanguageModel.LanguageModel | Journal
  >

  readonly events: <RM = never, EM = never>(
    prompt: string,
    options?: SessionRunOptions<RM, EM>,
  ) => Stream.Stream<
    AgentEvent,
    AgentSessionError<E, EM>,
    R | RM | LanguageModel.LanguageModel | Journal
  >

  readonly streamText: <RM = never, EM = never>(
    prompt: string,
    options?: SessionRunOptions<RM, EM>,
  ) => Stream.Stream<
    string,
    AgentSessionError<E, EM>,
    R | RM | LanguageModel.LanguageModel | Journal
  >
}

export const session = <R = never, E = never>(
  agent: AgentDefinition<R, E>,
  sessionId: SessionId | string,
): AgentSession<R, E> => {
  const sid = SessionId.is(sessionId) ? sessionId : SessionId.make(sessionId)

  const toRequest = <RM = never, EM = never>(
    prompt: string,
    options?: SessionRunOptions<RM, EM>,
  ): AgentRuntimeRequest<RM, EM> => {
    const req: {
      sessionId: SessionId
      prompt: string
      runId?: string | undefined
      policy?: RunPolicy | undefined
      middleware?: Middleware<RM, EM> | undefined
    } = {
      sessionId: sid,
      prompt,
    }
    if (options?.runId !== undefined) req.runId = options.runId
    if (options?.policy !== undefined) req.policy = options.policy
    if (options?.middleware !== undefined) req.middleware = options.middleware
    return req
  }

  const getEvents = <RM = never, EM = never>(prompt: string, options?: SessionRunOptions<RM, EM>) =>
    runAgent(agent, toRequest(prompt, options))

  const runEffect = <RM = never, EM = never>(prompt: string, options?: SessionRunOptions<RM, EM>) =>
    Effect.gen(function* () {
      const allEvents: Array<AgentEvent> = []
      yield* getEvents(prompt, options).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            allEvents.push(event)
          }),
        ),
      )
      const runId = RunId.make(options?.runId ?? `${sid}:0`)
      return fromEvents(sid, runId, allEvents)
    })

  const streamTextStream = <RM = never, EM = never>(
    prompt: string,
    options?: SessionRunOptions<RM, EM>,
  ) =>
    getEvents(prompt, options).pipe(
      Stream.filter(
        (event): event is Extract<AgentEvent, { readonly _tag: "TextDelta" }> =>
          event._tag === "TextDelta",
      ),
      Stream.map((event) => event.delta),
    )

  return {
    id: sid,
    run: runEffect,
    events: getEvents,
    streamText: streamTextStream,
  }
}
