import {
  Array as Arr,
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  Semaphore,
  Stream,
} from "effect"
import { LanguageModel, Prompt, type AiError } from "effect/unstable/ai"

import type { AgentDefinition } from "./Agent.ts"
import type { AgentEvent } from "./AgentEvents.ts"
import { RunId, SessionId } from "./DomainIds.ts"
import {
  FinalizationError,
  originalError,
  type ModelTimeout,
  type UnsafeModelRetry,
} from "./Error.ts"
import { EVENT_VERSION, type FinishReason, type JournalEvent } from "./Event.ts"
import { fromEvents, recoveryEvents, toPrompt } from "./History.ts"
import { run } from "./internal/run.ts"
import { Journal, type JournalAppendError, type JournalLoadError } from "./Journal.ts"
import {
  all as allMiddleware,
  empty as emptyMiddleware,
  type Middleware,
  MiddlewareService,
} from "./Middleware.ts"
import { mergePolicy, resolveRunPolicy, type RunPolicy } from "./RunPolicy.ts"
import type { InvalidToolName, ToolConflict } from "./ToolRegistry.ts"

/** Session metadata committed as a `session/meta` event before the run's user message. */
export interface SessionMeta {
  readonly title?: string | undefined
  readonly cwd?: string | undefined
}

/** Input for one direct, scoped kernel run. */
export interface AgentRuntimeRequest<out R = never, out E = never> {
  readonly sessionId: SessionId | string
  readonly runId?: RunId | string | undefined
  readonly prompt: string
  readonly policy?: RunPolicy | undefined
  readonly middleware?: Middleware<R, E> | undefined
  readonly meta?: SessionMeta | undefined
}

const sessionMetaEvents = (meta: SessionMeta | undefined): ReadonlyArray<JournalEvent> =>
  meta === undefined || (meta.title === undefined && meta.cwd === undefined)
    ? []
    : [
        {
          _tag: "session/meta",
          version: EVENT_VERSION,
          ...(meta.title === undefined ? undefined : { title: meta.title }),
          ...(meta.cwd === undefined ? undefined : { cwd: meta.cwd }),
        },
      ]

export type RuntimeError<E> =
  | E
  | AiError.AiError
  | JournalLoadError
  | JournalAppendError
  | FinalizationError
  | InvalidToolName
  | ToolConflict
  | UnsafeModelRetry
  | ModelTimeout

export type RuntimeStream<R, E> = Stream.Stream<
  AgentEvent,
  RuntimeError<E>,
  R | LanguageModel.LanguageModel | Journal
>

export interface AgentRuntimeService {
  readonly run: <R, E, RM = never, EM = never>(
    agent: AgentDefinition<R, E>,
    request: AgentRuntimeRequest<RM, EM>,
  ) => RuntimeStream<R | RM, E | EM>
}

const runtimeRun = <R, E, RM = never, EM = never>(
  agent: AgentDefinition<R, E>,
  request: AgentRuntimeRequest<RM, EM>,
): RuntimeStream<R | RM, E | EM> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const model = yield* LanguageModel.LanguageModel
      const journal = yield* Journal
      const installed = yield* Effect.serviceOption(MiddlewareService).pipe(
        Effect.map(Option.getOrElse(() => emptyMiddleware)),
      )
      const sessionId = SessionId.make(request.sessionId)
      const session = yield* journal.load(sessionId)
      const runId = RunId.make(request.runId ?? `${sessionId}:${session.revision}`)

      // Appends are serialized so the revision handed to the journal is always current.
      const revision = yield* Ref.make(session.revision)
      const lock = yield* Semaphore.make(1)
      const commit = (events: ReadonlyArray<JournalEvent>) =>
        Arr.isReadonlyArrayNonEmpty(events)
          ? lock.withPermit(
              Effect.gen(function* () {
                const next = yield* journal.append(sessionId, yield* Ref.get(revision), events)
                yield* Ref.set(revision, next)
              }),
            )
          : Effect.void

      const recovery = recoveryEvents(session.events)
      yield* commit(recovery)
      const history = yield* Ref.make(
        Prompt.concat(
          toPrompt(fromEvents([...session.events, ...recovery])),
          Prompt.make(request.prompt),
        ),
      )
      yield* commit([
        ...sessionMetaEvents(request.meta),
        { _tag: "user/message", version: EVENT_VERSION, content: request.prompt },
        { _tag: "run", version: EVENT_VERSION, sessionId, runId, state: "started" },
      ])

      const terminal = yield* Ref.make(false)
      const commitTerminal = (reason: FinishReason) =>
        Effect.gen(function* () {
          if (yield* Ref.get(terminal)) return
          yield* commit([
            {
              _tag: "run",
              version: EVENT_VERSION,
              sessionId,
              runId,
              state: reason === "completed" ? "completed" : "aborted",
              reason,
            },
          ])
          yield* Ref.set(terminal, true)
        })

      /* SAFETY: middleware R and E are erased for the interpreter and restored
       * in this function's public Stream type. */
      const events = run({
        sessionId,
        runId,
        agent,
        history,
        model,
        policy: resolveRunPolicy(mergePolicy(agent.policy, request.policy)),
        append: commit,
        middleware: allMiddleware(
          installed,
          (agent.middleware ?? emptyMiddleware) as Middleware,
          (request.middleware ?? emptyMiddleware) as Middleware,
        ),
      })

      /* SAFETY: the interpreter erased the agent's R and E; they are re-declared
       * here from the AgentDefinition and request types. */
      return events.pipe(
        Stream.tap((event) =>
          event._tag === "Finish" ? commitTerminal(event.reason) : Effect.void,
        ),
        Stream.catchCause((cause) =>
          Stream.unwrap(
            Effect.uninterruptible(Effect.exit(commitTerminal("failed"))).pipe(
              Effect.map((finalized) =>
                Stream.failCause<RuntimeError<E | EM>>(
                  Exit.isSuccess(finalized)
                    ? cause
                    : Cause.fail(
                        new FinalizationError({
                          sessionId,
                          primary: originalError(cause),
                          journal: originalError(finalized.cause),
                        }),
                      ),
                ),
              ),
            ),
          ),
        ),
        Stream.ensuring(Effect.uninterruptible(Effect.ignore(commitTerminal("interrupted")))),
      ) as RuntimeStream<R | RM, E | EM>
    }),
  )

/** Effect capability for interpreting explicit Agent values. */
export class AgentRuntime extends Context.Service<AgentRuntime, AgentRuntimeService>()(
  "roop/AgentRuntime",
) {
  static readonly run = runtimeRun
}

/** A default capability layer for consumers that prefer service lookup. */
export const AgentRuntimeLive: Layer.Layer<AgentRuntime> = Layer.succeed(
  AgentRuntime,
  AgentRuntime.of({ run: runtimeRun }),
)

export const runAgent = runtimeRun
