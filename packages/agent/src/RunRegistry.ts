import {
  Cause,
  Context,
  Deferred,
  Effect,
  Fiber,
  FiberMap,
  Layer,
  Queue,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect"

import { SessionId } from "./SessionId.ts"

export class RunNotFound extends Schema.TaggedErrorClass<RunNotFound>()("RunNotFound", {
  sessionId: SessionId,
}) {}

export class SessionBusy extends Schema.TaggedErrorClass<SessionBusy>()("SessionBusy", {
  sessionId: SessionId,
}) {}

export interface InterruptSignal {
  readonly isInterrupted: Effect.Effect<boolean>
  readonly await: Effect.Effect<void>
}

interface Entry {
  readonly token: symbol
  readonly interruptDeferred: Deferred.Deferred<void>
}

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
          const entry: Entry = {
            token: Symbol("RunEntry"),
            interruptDeferred,
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
            return yield* new SessionBusy({ sessionId })
          }

          const releaseClaim = Ref.update(admissions, (map) => {
            if (map.get(sessionId) !== entry) return map
            const next = new Map(map)
            next.delete(sessionId)
            return next
          })

          const signal: InterruptSignal = {
            isInterrupted: Deferred.isDone(interruptDeferred),
            await: Deferred.await(interruptDeferred),
          }

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
            yield* Effect.addFinalizer(() =>
              Fiber.interrupt(handle.fiber).pipe(
                Effect.flatMap(() => Fiber.await(handle.fiber)),
                Effect.asVoid,
              ),
            )
            return Stream.fromQueue(queue)
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
