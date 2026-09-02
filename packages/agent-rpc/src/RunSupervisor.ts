import {
  type Agent as AgentModule,
  type Error as AgentError,
  Journal as JournalModule,
  type RunEvent as RunEventModule,
  Runtime,
  type ToolRegistry,
} from "@roop/agent"
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect"
import { LanguageModel, type AiError } from "effect/unstable/ai"

const { Journal: JournalTag, JournalSnapshotSchema } = JournalModule
const { AgentRuntime: AgentRuntimeTag } = Runtime
type JournalAppendError = JournalModule.JournalAppendError
type JournalLoadError = JournalModule.JournalLoadError
type JournalSnapshot = JournalModule.JournalSnapshot
type JournalError = JournalModule.JournalError
type SessionSummary = JournalModule.SessionSummary
type AgentRuntimeRequest = Runtime.AgentRuntimeRequest
type RunHandle = Runtime.RunHandle<never>
type SessionMeta = Runtime.SessionMeta
type StartError = Runtime.StartError
type RunEvent = RunEventModule.RunEvent
type FinalizationError = AgentError.FinalizationError
type UnsafeModelRetry = AgentError.UnsafeModelRetry
type ModelTimeout = AgentError.ModelTimeout
type InvalidToolName = ToolRegistry.InvalidToolName
type ToolConflict = ToolRegistry.ToolConflict

/** A deterministic admission error for one active session. */
export class SessionBusy extends Schema.TaggedErrorClass<SessionBusy>()("SessionBusy", {
  sessionId: Schema.String,
}) {
  override get message(): string {
    return `Session '${this.sessionId}' is busy`
  }
}

/** A deterministic error for a missing active run. */
export class RunNotFound extends Schema.TaggedErrorClass<RunNotFound>()("RunNotFound", {
  sessionId: Schema.String,
}) {
  override get message(): string {
    return `Active run for session '${this.sessionId}' was not found`
  }
}

export type RunSupervisorError =
  | SessionBusy
  | RunNotFound
  | AiError.AiError
  | JournalLoadError
  | JournalAppendError
  | FinalizationError
  | InvalidToolName
  | ToolConflict
  | UnsafeModelRetry
  | ModelTimeout

export const RunHistory = JournalSnapshotSchema
export type RunHistory = typeof RunHistory.Type

export interface RunRequest {
  readonly sessionId: string
  readonly prompt: string
  readonly policy?: AgentRuntimeRequest["policy"]
  readonly meta?: SessionMeta | undefined
}

/** What `send` did with a message. */
export const SendOutcome = Schema.Struct({
  runId: Schema.String,
  /** `true` when no run was active and the message became the prompt of a new one. */
  started: Schema.Boolean,
})
export type SendOutcome = typeof SendOutcome.Type

export interface RunSupervisorService {
  /**
   * Start one run and return the owner stream. The stream is the run's
   * lifetime: dropping it interrupts the run.
   */
  readonly start: (request: RunRequest) => Stream.Stream<RunEvent, RunSupervisorError, never>
  /** Subscribe to an active run with an atomic replay/live handoff. */
  readonly subscribe: (sessionId: string) => Stream.Stream<RunEvent, RunSupervisorError, never>
  /**
   * Deliver a user message to the session's active run, or start a run with
   * it as the prompt when none is active (the run then lives in the
   * supervisor's scope and keeps going without subscribers). A run that has
   * ended, whether or not its last events are still being published, counts
   * as inactive.
   */
  readonly send: (
    sessionId: string,
    content: string,
  ) => Effect.Effect<SendOutcome, SessionBusy | StartError>
  /** Interrupt one active run and wait for its terminal event. */
  readonly interrupt: (sessionId: string) => Effect.Effect<void, RunNotFound>
  /** Read the durable event history for a session. */
  readonly history: (sessionId: string) => Effect.Effect<JournalSnapshot, JournalLoadError>
  /** Every stored session. */
  readonly list: Effect.Effect<ReadonlyArray<SessionSummary>, JournalError>
  /** Delete a stored session. Fails with SessionBusy while a run is active on it. */
  readonly delete: (sessionId: string) => Effect.Effect<void, SessionBusy | JournalError>
}

type QueueError = RunSupervisorError | Cause.Done
type EventQueue = Queue.Queue<RunEvent, QueueError>

interface ActiveRun {
  readonly sessionId: string
  readonly handle: RunHandle
  readonly subscribers: ReadonlyMap<number, EventQueue>
  readonly events: ReadonlyArray<RunEvent>
  /** Settled once the run's last event is published and the session released. */
  readonly released: Deferred.Deferred<void>
}

interface State {
  readonly nextSubscriber: number
  readonly active: ReadonlyMap<string, ActiveRun>
}

/**
 * Host-only lifecycle state for RPC and other transports.
 *
 * The map and fibers are allocated by the Layer. There is no module-global
 * run state. Registering a subscriber and taking its replay snapshot is one
 * atomic Ref.modify operation, so no event can fall between those actions.
 */
export class RunSupervisor extends Context.Service<RunSupervisor, RunSupervisorService>()(
  "roop/rpc/RunSupervisor",
) {}

export const make = <R = never>(
  agent: AgentModule.AgentDefinition<R, never>,
): Effect.Effect<
  RunSupervisorService,
  never,
  R | Runtime.AgentRuntime | JournalModule.Journal | LanguageModel.LanguageModel | Scope.Scope
> =>
  Effect.gen(function* () {
    const runtime = yield* AgentRuntimeTag
    const journal = yield* JournalTag
    const model = yield* LanguageModel.LanguageModel
    // Every run is forked into the supervisor's scope with the services the
    // hosted agent was built against; closing the layer interrupts them all.
    const scope = yield* Effect.scope
    const services = yield* Effect.context<R>()
    const state = yield* Ref.make<State>({ nextSubscriber: 0, active: new Map() })
    // Claiming a session and starting its run is one critical section, so a
    // concurrent `send` sees either no run or a complete one.
    const admission = yield* Semaphore.make(1)

    const close = (sessionId: string, cause?: Cause.Cause<RunSupervisorError>) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const entry = yield* Ref.modify(state, (current) => {
            const active = current.active.get(sessionId)
            if (active === undefined) return [undefined, current] as const
            const next = new Map(current.active)
            next.delete(sessionId)
            return [active, { ...current, active: next }] as const
          })
          if (entry === undefined) return
          const queues = [...entry.subscribers.values()]
          if (cause === undefined) {
            yield* Effect.forEach(queues, (queue) => Queue.end(queue), { discard: true })
          } else {
            yield* Effect.forEach(queues, (queue) => Queue.failCause(queue, cause), {
              discard: true,
            })
          }
          yield* Deferred.succeed(entry.released, undefined)
        }),
      )

    const publish = (sessionId: string, event: RunEvent) =>
      Effect.gen(function* () {
        const queues = yield* Ref.modify(state, (current) => {
          const entry = current.active.get(sessionId)
          if (entry === undefined) {
            // SAFETY: Ref.modify requires one stable tuple shape for both
            // branches; the empty queue list is the same output type.
            return [[] as ReadonlyArray<EventQueue>, current] as const
          }
          const active = new Map(current.active)
          active.set(sessionId, { ...entry, events: [...entry.events, event] })
          return [
            // SAFETY: every subscriber value is an EventQueue from the active
            // entry map.
            [...entry.subscribers.values()] as ReadonlyArray<EventQueue>,
            { ...current, active },
          ] as const
        })
        yield* Effect.forEach(queues, (queue) => Queue.offer(queue, event), { discard: true })
      })

    /** Relay the run's events to every subscriber, then release the session. */
    const relay = (entry: ActiveRun) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(
            restore(
              Stream.runForEach(entry.handle.events, (event) => publish(entry.sessionId, event)),
            ),
          )
          yield* close(
            entry.sessionId,
            Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause) ? exit.cause : undefined,
          )
        }),
      )

    /**
     * Claim the session, start its run in the supervisor's scope, and begin
     * relaying. The owner queue, when given, is registered before the first
     * event can be published.
     */
    const launch = (request: RunRequest, owner?: EventQueue) =>
      admission.withPermit(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const current = yield* Ref.get(state)
            if (current.active.has(request.sessionId)) {
              return yield* new SessionBusy({ sessionId: request.sessionId })
            }
            const runRequest: AgentRuntimeRequest = {
              sessionId: request.sessionId,
              prompt: request.prompt,
              ...(request.policy === undefined ? undefined : { policy: request.policy }),
              ...(request.meta === undefined ? undefined : { meta: request.meta }),
            }
            const handle = yield* runtime
              .start(agent, runRequest)
              .pipe(
                Effect.provideService(LanguageModel.LanguageModel, model),
                Effect.provideService(JournalTag, journal),
                Scope.provide(scope),
                Effect.provideContext(services),
              )
            const released = yield* Deferred.make<void>()
            const entry = yield* Ref.modify(state, (current): readonly [ActiveRun, State] => {
              const subscribers = new Map<number, EventQueue>()
              if (owner !== undefined) subscribers.set(current.nextSubscriber, owner)
              const entry: ActiveRun = {
                sessionId: request.sessionId,
                handle,
                subscribers,
                events: [],
                released,
              }
              const active = new Map(current.active)
              active.set(request.sessionId, entry)
              return [entry, { nextSubscriber: current.nextSubscriber + 1, active }]
            })
            yield* Effect.forkIn(relay(entry), scope)
            return entry
          }),
        ),
      )

    const addSubscriber = (sessionId: string, queue: EventQueue) =>
      Ref.modify(state, (current) => {
        const entry = current.active.get(sessionId)
        if (entry === undefined) return [Option.none<ReadonlyArray<RunEvent>>(), current] as const
        const id = current.nextSubscriber
        const subscribers = new Map(entry.subscribers)
        subscribers.set(id, queue)
        const active = new Map(current.active)
        active.set(sessionId, { ...entry, subscribers })
        return [Option.some([...entry.events]), { nextSubscriber: id + 1, active }] as const
      })

    const removeSubscriber = (sessionId: string, queue: EventQueue) =>
      Ref.update(state, (current) => {
        const entry = current.active.get(sessionId)
        if (entry === undefined) return current
        const subscribers = new Map(entry.subscribers)
        for (const [id, item] of subscribers) {
          if (item === queue) subscribers.delete(id)
        }
        const active = new Map(current.active)
        active.set(sessionId, { ...entry, subscribers })
        return { ...current, active }
      })

    const release = (sessionId: string, queue: EventQueue) =>
      removeSubscriber(sessionId, queue).pipe(Effect.andThen(Queue.shutdown(queue)))

    /** Interrupt the run and wait until the supervisor has released its session. */
    const stop = (entry: ActiveRun) =>
      entry.handle.interrupt.pipe(Effect.andThen(Deferred.await(entry.released)))

    // Both streams register their cleanup as a finalizer of the stream's own
    // scope, inside the uninterruptible section that registers the queue, so
    // a consumer interrupted before it reads its first event still releases
    // what it registered.
    const start = (request: RunRequest): Stream.Stream<RunEvent, RunSupervisorError, never> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<RunEvent, QueueError>()
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const entry = yield* launch(request, queue)
              // The owner stream is the run's lifetime: its end interrupts the
              // run, and the relay still publishes the terminal event.
              yield* Effect.addFinalizer(() =>
                stop(entry).pipe(Effect.andThen(release(request.sessionId, queue))),
              )
            }),
          )
          return Stream.fromQueue(queue)
        }),
      )

    const subscribe = (sessionId: string): Stream.Stream<RunEvent, RunSupervisorError, never> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<RunEvent, QueueError>()
          const replay = yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const replay = yield* addSubscriber(sessionId, queue)
              if (Option.isSome(replay)) {
                yield* Effect.addFinalizer(() => release(sessionId, queue))
              }
              return replay
            }),
          )
          if (Option.isSome(replay)) {
            return Stream.concat(Stream.fromIterable(replay.value), Stream.fromQueue(queue))
          }
          yield* Queue.shutdown(queue)
          return yield* new RunNotFound({ sessionId })
        }),
      )

    const send = (sessionId: string, content: string) =>
      Effect.gen(function* () {
        const entry = (yield* Ref.get(state)).active.get(sessionId)
        if (entry !== undefined) {
          const delivered = yield* Effect.exit(entry.handle.send({ _tag: "user/message", content }))
          if (Exit.isSuccess(delivered)) {
            return { runId: String(entry.handle.runId), started: false }
          }
          // The run ended under us; let the relay release the session first.
          yield* Deferred.await(entry.released)
        }
        const started = yield* launch({ sessionId, prompt: content })
        return { runId: String(started.handle.runId), started: true }
      })

    return RunSupervisor.of({
      start,
      subscribe,
      send,
      interrupt: (sessionId) =>
        Effect.gen(function* () {
          const entry = (yield* Ref.get(state)).active.get(sessionId)
          if (entry === undefined) return yield* new RunNotFound({ sessionId })
          yield* stop(entry)
        }),
      history: (sessionId) => journal.load(sessionId),
      list: journal.list,
      delete: (sessionId) =>
        Effect.gen(function* () {
          const active = (yield* Ref.get(state)).active.has(sessionId)
          if (active) return yield* new SessionBusy({ sessionId })
          yield* journal.delete(sessionId)
        }),
    })
  })

export const live = <R = never>(agent: AgentModule.AgentDefinition<R, never>) =>
  Layer.effect(RunSupervisor, make(agent))

export const RunSupervisorLive = live
