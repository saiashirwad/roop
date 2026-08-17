import {
  type Cause,
  Context,
  Deferred,
  Effect,
  Fiber,
  FiberMap,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  type Scope,
  Stream,
} from "effect"

import { SessionId } from "./DomainIds.ts"

/* ========================================================================== *
 * Schemas & Errors                                                           *
 * ========================================================================== */

export class RunNotFound extends Schema.TaggedErrorClass<RunNotFound>()("RunNotFound", {
  sessionId: SessionId,
}) {}

export class SessionBusy extends Schema.TaggedErrorClass<SessionBusy>()("SessionBusy", {
  sessionId: SessionId,
}) {}

/* ========================================================================== *
 * Interrupt & Steer Control Signals                                          *
 * ========================================================================== */

export type ControlSignal =
  | { readonly _tag: "Interrupted" }
  | { readonly _tag: "Steered"; readonly steerPrompt: string }

export interface InterruptSignal {
  readonly isInterrupted: Effect.Effect<boolean>
  readonly await: Effect.Effect<void>
  readonly pollSteer: Effect.Effect<Option.Option<string>>
  readonly awaitSteer: Effect.Effect<string>
  readonly awaitSignal: Effect.Effect<ControlSignal>
}

export const InterruptSignal = {
  make: (
    options: {
      readonly interruptDeferred?: Deferred.Deferred<void>
      readonly steerQueue?: Queue.Queue<string>
    } = {},
  ): InterruptSignal => {
    const interruptDeferred = options.interruptDeferred
    const steerQueue = options.steerQueue
    const isInterrupted =
      interruptDeferred !== undefined ? Deferred.isDone(interruptDeferred) : Effect.succeed(false)
    const awaitInterrupt =
      interruptDeferred !== undefined ? Deferred.await(interruptDeferred) : Effect.never
    const pollSteer =
      steerQueue !== undefined ? Queue.poll(steerQueue) : Effect.succeed(Option.none())
    const awaitSteer = steerQueue !== undefined ? Queue.take(steerQueue) : Effect.never
    return {
      isInterrupted,
      await: awaitInterrupt,
      pollSteer,
      awaitSteer,
      awaitSignal: Effect.raceFirst(
        awaitInterrupt.pipe(Effect.as({ _tag: "Interrupted" as const })),
        awaitSteer.pipe(Effect.map((steerPrompt) => ({ _tag: "Steered" as const, steerPrompt }))),
      ),
    }
  },
  noop: (): InterruptSignal => InterruptSignal.make(),
  interrupted: (): InterruptSignal => ({
    isInterrupted: Effect.succeed(true),
    await: Effect.void,
    pollSteer: Effect.succeed(Option.none()),
    awaitSteer: Effect.never,
    awaitSignal: Effect.succeed({ _tag: "Interrupted" as const }),
  }),
}

interface Entry {
  readonly interruptDeferred: Deferred.Deferred<void>
  readonly steerQueue: Queue.Queue<string>
}

/* ========================================================================== *
 * Service Definition: RunRegistry                                            *
 * ========================================================================== */

export class RunRegistry extends Context.Service<
  RunRegistry,
  {
    readonly run: <A, E, R>(
      sessionId: SessionId | string,
      effect: (signal: InterruptSignal) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | SessionBusy, R>

    readonly runStream: <A, E, R>(
      sessionId: SessionId | string,
      stream: (signal: InterruptSignal) => Stream.Stream<A, E, R>,
    ) => Stream.Stream<A, E | SessionBusy, R>

    readonly steer: (
      sessionId: SessionId | string,
      message: string,
    ) => Effect.Effect<void, RunNotFound>
    readonly interrupt: (sessionId: SessionId | string) => Effect.Effect<void, RunNotFound>
    readonly isActive: (sessionId: SessionId | string) => Effect.Effect<boolean>
    readonly activeSessions: Effect.Effect<ReadonlyArray<SessionId>>
  }
>()("roop/RunRegistry") {}

export const make: Effect.Effect<RunRegistry["Service"], never, Scope.Scope> = Effect.gen(
  function* () {
    const fibers = yield* FiberMap.make<SessionId, unknown, unknown>()
    const admissions = yield* Ref.make<ReadonlyMap<SessionId, Entry>>(new Map())

    const start = <A, E, R>(
      sessionId: SessionId,
      fn: (signal: InterruptSignal) => Effect.Effect<A, E, R>,
    ): Effect.Effect<
      {
        readonly fiber: Fiber.Fiber<A, E>
        readonly entry: Entry
        readonly signal: InterruptSignal
      },
      SessionBusy,
      R
    > =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const interruptDeferred = yield* Deferred.make<void>()
          const steerQueue = yield* Queue.unbounded<string>()
          const entry: Entry = {
            interruptDeferred,
            steerQueue,
          }

          const claimed = yield* Ref.modify(admissions, (map) => {
            if (map.has(sessionId)) {
              return [false, map] as const
            }
            const next = new Map(map)
            next.set(sessionId, entry)
            return [true, next] as const
          })

          if (!claimed) {
            yield* Queue.shutdown(steerQueue)
            return yield* new SessionBusy({ sessionId })
          }

          const releaseClaim = Effect.gen(function* () {
            yield* Ref.update(admissions, (map) => {
              if (map.get(sessionId) !== entry) return map
              const next = new Map(map)
              next.delete(sessionId)
              return next
            })
            yield* Queue.shutdown(steerQueue)
          })

          const signal = InterruptSignal.make({ interruptDeferred, steerQueue })

          const supervised = Effect.suspend(() => fn(signal)).pipe(
            restore,
            Effect.ensuring(releaseClaim),
          )

          const fiber = yield* FiberMap.run(fibers, sessionId, supervised).pipe(
            Effect.catchCause((cause) =>
              releaseClaim.pipe(Effect.andThen(Effect.failCause(cause))),
            ),
          )

          /* SAFETY: FiberMap supervises the forked fiber executing the typed effect. */
          const typedFiber = fiber as Fiber.Fiber<A, E>

          return {
            fiber: typedFiber,
            entry,
            signal,
          }
        }),
      )

    return RunRegistry.of({
      run: (sessionId, effect) => {
        const sid = SessionId.make(sessionId)
        return Effect.gen(function* () {
          const handle = yield* start(sid, effect)
          return yield* Fiber.join(handle.fiber)
        })
      },
      runStream: <A, E, R>(
        sessionId: SessionId | string,
        streamFn: (signal: InterruptSignal) => Stream.Stream<A, E, R>,
      ): Stream.Stream<A, E | SessionBusy, R> => {
        const sid = SessionId.make(sessionId)
        return Stream.unwrap(
          Effect.gen(function* () {
            const queue = yield* Effect.acquireRelease(
              Queue.bounded<A, E | Cause.Done<void>>(128),
              (q) => Queue.shutdown(q),
            )
            const handle = yield* start(sid, (signal) =>
              Stream.runIntoQueue(streamFn(signal), queue),
            )
            yield* Effect.addFinalizer(() => Fiber.interrupt(handle.fiber))
            return Stream.fromQueue(queue)
          }),
        )
      },
      steer: (sessionId, message) => {
        const sid = SessionId.make(sessionId)
        return Ref.get(admissions).pipe(
          Effect.flatMap((map) => {
            const entry = map.get(sid)
            return entry === undefined
              ? Effect.fail(new RunNotFound({ sessionId: sid }))
              : Queue.offer(entry.steerQueue, message).pipe(Effect.asVoid)
          }),
        )
      },
      interrupt: (sessionId) => {
        const sid = SessionId.make(sessionId)
        return Ref.get(admissions).pipe(
          Effect.flatMap((map) => {
            const entry = map.get(sid)
            return entry === undefined
              ? Effect.fail(new RunNotFound({ sessionId: sid }))
              : Deferred.succeed(entry.interruptDeferred, undefined).pipe(Effect.asVoid)
          }),
        )
      },
      isActive: (sessionId) => {
        const sid = SessionId.make(sessionId)
        return Ref.get(admissions).pipe(Effect.map((map) => map.has(sid)))
      },
      activeSessions: Ref.get(admissions).pipe(Effect.map((map) => Array.from(map.keys()))),
    })
  },
)

export const RunRegistryLive = Layer.effect(RunRegistry, make)
