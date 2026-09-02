import {
  type Agent as AgentModule,
  type AgentEvents,
  type Error as AgentError,
  Journal as JournalModule,
  Runtime,
  type ToolRegistry,
} from "@roop/agent"
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Stream,
} from "effect"
import { LanguageModel, type AiError } from "effect/unstable/ai"

const { Journal: JournalTag, JournalSnapshotSchema } = JournalModule
const { AgentRuntime: AgentRuntimeTag } = Runtime
type JournalAppendError = JournalModule.JournalAppendError
type JournalLoadError = JournalModule.JournalLoadError
type JournalSnapshot = JournalModule.JournalSnapshot
type AgentRuntimeRequest = Runtime.AgentRuntimeRequest
type AgentEvent = AgentEvents.AgentEvent
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
}

export interface RunSupervisorService {
  /** Start one run and return the owner stream. */
  readonly start: (request: RunRequest) => Stream.Stream<AgentEvent, RunSupervisorError, never>
  /** Subscribe to an active run with an atomic replay/live handoff. */
  readonly subscribe: (sessionId: string) => Stream.Stream<AgentEvent, RunSupervisorError, never>
  /** Interrupt one active run. */
  readonly interrupt: (sessionId: string) => Effect.Effect<void, RunNotFound>
  /** Read the durable event history for a session. */
  readonly history: (sessionId: string) => Effect.Effect<JournalSnapshot, JournalLoadError>
}

type QueueError = RunSupervisorError | Cause.Done
type EventQueue = Queue.Queue<AgentEvent, QueueError>

interface ActiveRun {
  readonly sessionId: string
  readonly owner: EventQueue
  readonly subscribers: ReadonlyMap<number, EventQueue>
  readonly events: ReadonlyArray<AgentEvent>
  readonly fiber: Deferred.Deferred<Fiber.Fiber<void, unknown>>
}

interface State {
  readonly nextSubscriber: number
  readonly active: ReadonlyMap<string, ActiveRun>
}

const asSupervisorCause = (cause: Cause.Cause<unknown>): Cause.Cause<RunSupervisorError> =>
  /* SAFETY: AgentRuntime is installed with the explicit hosted agent. Its
   * stream error is the documented RunSupervisorError boundary. */
  cause as Cause.Cause<RunSupervisorError>

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
  R | Runtime.AgentRuntime | JournalModule.Journal | LanguageModel.LanguageModel
> =>
  Effect.gen(function* () {
    const runtime = yield* AgentRuntimeTag
    const journal = yield* JournalTag
    const model = yield* LanguageModel.LanguageModel
    const state = yield* Ref.make<State>({ nextSubscriber: 0, active: new Map() })

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
          const queues = [entry.owner, ...entry.subscribers.values()]
          if (cause === undefined) {
            yield* Effect.forEach(queues, (queue) => Queue.end(queue), { discard: true })
          } else {
            yield* Effect.forEach(queues, (queue) => Queue.failCause(queue, cause), {
              discard: true,
            })
          }
        }),
      )

    const publish = (sessionId: string, event: AgentEvent) =>
      Effect.gen(function* () {
        const queues = yield* Ref.modify(state, (current) => {
          const entry = current.active.get(sessionId)
          if (entry === undefined) {
            // SAFETY: Ref.modify requires one stable tuple shape for both
            // branches; the empty queue list is the same output type.
            return [[] as ReadonlyArray<EventQueue>, current] as const
          }
          const updated: ActiveRun = {
            ...entry,
            events: [...entry.events, event],
          }
          const active = new Map(current.active)
          active.set(sessionId, updated)
          return [
            // SAFETY: The owner and all subscriber values are EventQueue
            // instances from the active entry map.
            [entry.owner, ...entry.subscribers.values()] as ReadonlyArray<EventQueue>,
            { ...current, active },
          ] as const
        })
        yield* Effect.forEach(queues, (queue) => Queue.offer(queue, event), { discard: true })
      })

    const addSubscriber = (sessionId: string, queue: EventQueue) =>
      Ref.modify(state, (current) => {
        const entry = current.active.get(sessionId)
        if (entry === undefined) return [Option.none<ReadonlyArray<AgentEvent>>(), current] as const
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

    const stopOwner = (sessionId: string) =>
      Effect.gen(function* () {
        const entry = yield* Ref.get(state).pipe(
          Effect.map((current) => current.active.get(sessionId)),
        )
        if (entry === undefined) return
        const fiber = yield* Deferred.await(entry.fiber)
        yield* Fiber.interrupt(fiber)
      }).pipe(Effect.ignore)

    const consumer = (
      sessionId: string,
      queue: EventQueue,
      replay: ReadonlyArray<AgentEvent>,
      owner = false,
    ) =>
      Stream.concat(Stream.fromIterable(replay), Stream.fromQueue(queue)).pipe(
        Stream.ensuring(
          (owner ? stopOwner(sessionId) : Effect.void).pipe(
            Effect.andThen(removeSubscriber(sessionId, queue)),
            Effect.andThen(Queue.shutdown(queue)),
            Effect.ignore,
          ),
        ),
      )

    const start = (request: RunRequest): Stream.Stream<AgentEvent, RunSupervisorError, never> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<AgentEvent, QueueError>()
          const fiber = yield* Deferred.make<Fiber.Fiber<void, unknown>>()
          const claimed = yield* Ref.modify(state, (current) => {
            if (current.active.has(request.sessionId)) return [false, current] as const
            const active = new Map(current.active)
            active.set(request.sessionId, {
              sessionId: request.sessionId,
              owner: queue,
              subscribers: new Map(),
              events: [],
              fiber,
            })
            return [true, { ...current, active }] as const
          })
          if (!claimed) return yield* new SessionBusy({ sessionId: request.sessionId })

          const runRequest: AgentRuntimeRequest = {
            sessionId: request.sessionId,
            prompt: request.prompt,
            ...(request.policy === undefined ? undefined : { policy: request.policy }),
          }
          const producer = Effect.gen(function* () {
            const finished = yield* Ref.make(false)
            const stream = runtime
              .run(agent, runRequest)
              .pipe(
                Stream.provideService(LanguageModel.LanguageModel, model),
                Stream.provideService(JournalTag, journal),
              )
            const exit = yield* Effect.exit(
              // SAFETY: the hosted Agent is fixed at layer construction and
              // its runtime error channel is the supervisor boundary.
              Stream.runForEach(stream, (event) =>
                Effect.gen(function* () {
                  if (event._tag === "Finish") yield* Ref.set(finished, true)
                  yield* publish(request.sessionId, event)
                }),
              ) as Effect.Effect<void, RunSupervisorError>,
            )
            if (Exit.isFailure(exit)) {
              if (Cause.hasInterruptsOnly(exit.cause)) {
                if (!(yield* Ref.get(finished))) {
                  yield* publish(request.sessionId, { _tag: "Finish", reason: "interrupted" })
                }
                yield* close(request.sessionId)
              } else {
                yield* close(request.sessionId, asSupervisorCause(exit.cause))
              }
            } else {
              if (!(yield* Ref.get(finished))) {
                yield* publish(request.sessionId, { _tag: "Finish", reason: "completed" })
              }
              yield* close(request.sessionId)
            }
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                yield* publish(request.sessionId, { _tag: "Finish", reason: "interrupted" })
                yield* close(request.sessionId)
              }),
            ),
          )
          const producerFiber = yield* producer.pipe(Effect.forkScoped)
          yield* Deferred.succeed(fiber, producerFiber)
          return consumer(request.sessionId, queue, [], true)
        }),
      )

    const subscribe = (sessionId: string): Stream.Stream<AgentEvent, RunSupervisorError, never> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<AgentEvent, QueueError>()
          const replay = yield* addSubscriber(sessionId, queue)
          if (Option.isSome(replay)) return consumer(sessionId, queue, replay.value, false)
          yield* Queue.shutdown(queue)
          return yield* new RunNotFound({ sessionId })
        }),
      )

    return RunSupervisor.of({
      start,
      subscribe,
      interrupt: (sessionId) =>
        Effect.gen(function* () {
          const entry = yield* Ref.get(state).pipe(
            Effect.map((current) => current.active.get(sessionId)),
          )
          if (entry === undefined) return yield* new RunNotFound({ sessionId })
          const fiber = yield* Deferred.await(entry.fiber)
          yield* Fiber.interrupt(fiber)
        }),
      history: (sessionId) => journal.load(sessionId),
    })
  })

export const live = <R = never>(agent: AgentModule.AgentDefinition<R, never>) =>
  Layer.effect(RunSupervisor, make(agent))

export const RunSupervisorLive = live
