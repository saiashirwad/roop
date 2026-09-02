import {
  Array as Arr,
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  type Scope,
  Semaphore,
  Stream,
} from "effect"
import { LanguageModel, Prompt, type AiError } from "effect/unstable/ai"

import type { AgentDefinition } from "./Agent.ts"
import { type AgentResult, emptyFold, foldEvent, fromFold } from "./AgentResult.ts"
import { RunId, SessionId } from "./DomainIds.ts"
import {
  FinalizationError,
  originalError,
  type ModelTimeout,
  type UnsafeModelRetry,
} from "./Error.ts"
import {
  addUsage,
  emptyUsage,
  EVENT_VERSION,
  type FinishReason,
  type JournalEvent,
  stampJournalEvent,
  type Unstamped,
} from "./Event.ts"
import { fromEvents, recoveryEvents, toPrompt } from "./History.ts"
import { type InboxMessage, make as makeInbox, type RunEnded } from "./Inbox.ts"
import { run, type RunOutcome, type RunStreamError } from "./internal/run.ts"
import { Journal, type JournalAppendError, type JournalLoadError } from "./Journal.ts"
import {
  all as allMiddleware,
  empty as emptyMiddleware,
  type Middleware,
  MiddlewareService,
} from "./Middleware.ts"
import { type RunEvent, stampLiveEvent, type UnstampedLiveEvent } from "./RunEvent.ts"
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

const sessionMetaEvents = (meta: SessionMeta | undefined): ReadonlyArray<Unstamped<JournalEvent>> =>
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

/** What can fail before a run is forked: loading the session and committing its opening events. */
export type StartError = JournalLoadError | JournalAppendError

/** The services a run needs beyond the agent's own. */
export type RuntimeServices<R> = R | LanguageModel.LanguageModel | Journal

/**
 * The live view of one run: its journal events in commit order, interleaved
 * with live-only deltas, tool output, and forwarded child events.
 */
export type RuntimeStream<R, E> = Stream.Stream<RunEvent, RuntimeError<E>, RuntimeServices<R>>

/**
 * A started run. The run fiber lives in the scope `start` was given: closing
 * that scope interrupts the run, which then commits `run` aborted/interrupted
 * before the handle settles.
 */
export interface RunHandle<E> {
  readonly runId: RunId
  readonly sessionId: SessionId
  /**
   * The run's events from its opening `user/message` to its terminal `run`
   * event, then end of stream; a failed run fails the stream after its events.
   * The stream is backed by one queue, so it has one consumer: the owner.
   * Fan-out with replay is a host concern (`RunSupervisor` in `agent-rpc`).
   * Nothing is lost while nobody reads; the queue is unbounded.
   */
  readonly events: Stream.Stream<RunEvent, RuntimeError<E>>
  /**
   * Settles when the run ends: the folded `AgentResult` for a completed,
   * stopped, or interrupted run (`finishReason` says which), the run's error
   * for a failed one.
   */
  readonly result: Effect.Effect<AgentResult, RuntimeError<E>>
  /** Interrupt the run and wait until its terminal `run` event is committed. */
  readonly interrupt: Effect.Effect<void>
  /**
   * Deliver a message to the run's inbox. The interpreter commits it as a
   * `user/message` at the next step boundary and the model sees it in the
   * following request. Fails with `RunEnded` once the run has ended; a
   * message accepted before that but never reached by a step boundary is
   * dropped with the run.
   */
  readonly send: (message: InboxMessage) => Effect.Effect<void, RunEnded>
}

export type RuntimeStart<R, E> = Effect.Effect<
  RunHandle<E>,
  StartError,
  RuntimeServices<R> | Scope.Scope
>

export interface AgentRuntimeService {
  /** Start a run in the current scope and return its handle. The primitive. */
  readonly start: <R, E, RM = never, EM = never>(
    agent: AgentDefinition<R, E>,
    request: AgentRuntimeRequest<RM, EM>,
  ) => RuntimeStart<R | RM, E | EM>
  /** Start a run whose lifetime is the returned stream: dropping the stream interrupts it. */
  readonly run: <R, E, RM = never, EM = never>(
    agent: AgentDefinition<R, E>,
    request: AgentRuntimeRequest<RM, EM>,
  ) => RuntimeStream<R | RM, E | EM>
}

const runtimeStart = <R, E, RM = never, EM = never>(
  agent: AgentDefinition<R, E>,
  request: AgentRuntimeRequest<RM, EM>,
): RuntimeStart<R | RM, E | EM> =>
  Effect.gen(function* () {
    const model = yield* LanguageModel.LanguageModel
    const journal = yield* Journal
    const installed = yield* Effect.serviceOption(MiddlewareService).pipe(
      Effect.map(Option.getOrElse(() => emptyMiddleware)),
    )
    const sessionId = SessionId.make(request.sessionId)
    const session = yield* journal.load(sessionId)
    const runId = RunId.make(request.runId ?? `${sessionId}:${session.revision}`)

    const queue = yield* Queue.unbounded<RunEvent, Cause.Done>()
    const fold = yield* Ref.make(emptyFold)
    const settled = yield* Deferred.make<AgentResult, RuntimeError<E | EM>>()
    const inbox = yield* makeInbox(runId)

    const publish = (events: ReadonlyArray<RunEvent>) =>
      Effect.gen(function* () {
        yield* Ref.update(fold, (current) => events.reduce(foldEvent, current))
        yield* Queue.offerAll(queue, events)
      })

    // Appends are serialized so the revision handed to the journal is
    // always current, and events reach the consumer in commit order.
    const revision = yield* Ref.make(session.revision)
    const usage = yield* Ref.make(emptyUsage)
    const lock = yield* Semaphore.make(1)
    const commit = (
      events: ReadonlyArray<Unstamped<JournalEvent>>,
    ): Effect.Effect<ReadonlyArray<JournalEvent>, JournalAppendError> =>
      Arr.isReadonlyArrayNonEmpty(events)
        ? lock.withPermit(
            Effect.gen(function* () {
              const at = yield* Clock.currentTimeMillis
              const stamped = Arr.map(events, (event) => stampJournalEvent(event, at))
              const next = yield* journal.append(sessionId, yield* Ref.get(revision), stamped)
              yield* Ref.set(revision, next)
              for (const event of stamped) {
                if (event._tag !== "step" || event.usage === undefined) continue
                const stepUsage = event.usage
                yield* Ref.update(usage, (total) => addUsage(total, stepUsage))
              }
              yield* publish(stamped)
              return stamped
            }),
          )
        : Effect.succeed([])
    const emit = (event: UnstampedLiveEvent) =>
      Effect.gen(function* () {
        const at = yield* Clock.currentTimeMillis
        yield* publish([stampLiveEvent(event, at)])
      })

    const recovery = yield* commit(recoveryEvents(session.events))
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
            usage: yield* Ref.get(usage),
          },
        ])
        yield* Ref.set(terminal, true)
      })

    /* SAFETY: middleware R and E are erased for the interpreter and restored
     * in this function's public handle type. */
    const interpreter = run({
      sessionId,
      runId,
      agent,
      history,
      model,
      policy: resolveRunPolicy(mergePolicy(agent.policy, request.policy)),
      append: (events) => Effect.asVoid(commit(events)),
      emit,
      inbox,
      middleware: allMiddleware(
        installed,
        (agent.middleware ?? emptyMiddleware) as Middleware,
        (request.middleware ?? emptyMiddleware) as Middleware,
      ),
    })

    /**
     * The terminal `run` event is committed exactly once, whatever ended the
     * interpreter, and only then do the event stream and the result settle.
     * An interrupted run is a settled run: its result carries `interrupted`.
     */
    const finalize = (exit: Exit.Exit<RunOutcome, RunStreamError<E | EM>>) =>
      Effect.gen(function* () {
        const reason: FinishReason = Exit.isSuccess(exit)
          ? exit.value
          : Cause.hasInterruptsOnly(exit.cause)
            ? "interrupted"
            : "failed"
        const finalized = yield* Effect.exit(commitTerminal(reason))
        yield* inbox.close
        const failure: Option.Option<Cause.Cause<RuntimeError<E | EM>>> =
          Exit.isFailure(exit) && reason === "failed"
            ? Option.some(
                Exit.isSuccess(finalized)
                  ? exit.cause
                  : Cause.fail(
                      new FinalizationError({
                        sessionId,
                        primary: originalError(exit.cause),
                        journal: originalError(finalized.cause),
                      }),
                    ),
              )
            : Exit.isFailure(finalized)
              ? Option.some(finalized.cause)
              : Option.none()
        const result = fromFold(sessionId, runId, yield* Ref.get(fold))
        yield* Queue.end(queue)
        yield* Option.match(failure, {
          onNone: () => Deferred.succeed(settled, result),
          onSome: (cause) => Deferred.failCause(settled, cause),
        })
      })

    // Interrupting the run (directly or by closing its scope) lands in
    // `finalize`, which runs to completion before the fiber ends. The fiber
    // is forked uninterruptible so an interrupt that arrives before it has
    // run its first instruction still reaches `finalize`, through the
    // interruptible interpreter region, instead of ending the fiber outright.
    const fiber = yield* Effect.forkScoped(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(Effect.interruptible(Effect.scoped(interpreter)))
        yield* finalize(exit)
      }),
      { uninterruptible: true },
    )

    const handle: RunHandle<E | EM> = {
      runId,
      sessionId,
      events: Stream.fromQueue(queue).pipe(
        Stream.concat(Stream.fromEffectDrain(Deferred.await(settled))),
      ),
      result: Deferred.await(settled),
      interrupt: Fiber.interrupt(fiber),
      send: inbox.send,
    }
    return handle
  })

const runtimeRun = <R, E, RM = never, EM = never>(
  agent: AgentDefinition<R, E>,
  request: AgentRuntimeRequest<RM, EM>,
): RuntimeStream<R | RM, E | EM> =>
  Stream.unwrap(Effect.map(runtimeStart(agent, request), (handle) => handle.events))

/** Effect capability for interpreting explicit Agent values. */
export class AgentRuntime extends Context.Service<AgentRuntime, AgentRuntimeService>()(
  "roop/AgentRuntime",
) {
  static readonly start = runtimeStart
  static readonly run = runtimeRun
}

/** A default capability layer for consumers that prefer service lookup. */
export const AgentRuntimeLive: Layer.Layer<AgentRuntime> = Layer.succeed(
  AgentRuntime,
  AgentRuntime.of({ start: runtimeStart, run: runtimeRun }),
)

export const startAgent = runtimeStart
export const runAgent = runtimeRun
