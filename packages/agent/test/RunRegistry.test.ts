import { assert, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Option, Scope, Stream } from "effect"

import { SessionId } from "../src/DomainIds.ts"
import {
  make,
  type RunNotFound,
  RunRegistry,
  RunRegistryLive,
  type SessionBusy,
} from "../src/RunRegistry.ts"

it.layer(RunRegistryLive)("RunRegistry", (it) => {
  it.effect("unconsumed stream does not claim session", () =>
    Effect.gen(function* () {
      const registry = yield* RunRegistry
      const sid = SessionId.make("unconsumed")

      const stream = registry.runStream(sid, () => Stream.make(1, 2, 3))
      void stream

      const active = yield* registry.isActive(sid)
      assert.strictEqual(active, false)
    }),
  )

  it.effect("materializing stream claims session and cleans up on completion", () =>
    Effect.gen(function* () {
      const registry = yield* RunRegistry
      const sid = SessionId.make("stream-claim")
      const started = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()

      const stream = registry.runStream(sid, () =>
        Stream.fromEffect(Deferred.succeed(started, undefined)).pipe(
          Stream.flatMap(() => Stream.fromEffect(Deferred.await(gate))),
          Stream.flatMap(() => Stream.make(1, 2)),
        ),
      )

      const fiber = yield* Effect.forkChild(Stream.runCollect(stream))

      // Wait until the run is claimed and started
      yield* Deferred.await(started)

      assert.strictEqual(yield* registry.isActive(sid), true)
      assert.deepStrictEqual(yield* registry.activeSessions, [sid])

      // Complete the gate
      yield* Deferred.succeed(gate, undefined)
      const items = yield* Fiber.join(fiber)
      assert.deepStrictEqual([...items], [1, 2])

      assert.strictEqual(yield* registry.isActive(sid), false)
      assert.deepStrictEqual(yield* registry.activeSessions, [])
    }),
  )

  it.effect("concurrent runs on the same session fail with SessionBusy", () =>
    Effect.gen(function* () {
      const registry = yield* RunRegistry
      const sid = SessionId.make("busy-test")
      const started = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()

      const fiber1 = yield* Effect.forkChild(
        registry.run(sid, () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.as("first"),
          ),
        ),
      )

      // Wait until first run is active
      yield* Deferred.await(started)
      assert.strictEqual(yield* registry.isActive(sid), true)

      // Second attempt on same session
      const exit2 = yield* Effect.exit(registry.run(sid, () => Effect.succeed("second")))
      assert.ok(Exit.isFailure(exit2))
      /* SAFETY: Concurrent run attempts fail with SessionBusy. */
      const error = Option.getOrThrow(Exit.findErrorOption(exit2)) as SessionBusy
      assert.strictEqual(error._tag, "SessionBusy")
      assert.strictEqual(error.sessionId, sid)

      // Second stream attempt on same session
      const exitStream = yield* Effect.exit(
        Stream.runCollect(registry.runStream(sid, () => Stream.make(1))),
      )
      assert.ok(Exit.isFailure(exitStream))
      /* SAFETY: Concurrent stream attempts fail with SessionBusy. */
      const streamError = Option.getOrThrow(Exit.findErrorOption(exitStream)) as SessionBusy
      assert.strictEqual(streamError._tag, "SessionBusy")
      assert.strictEqual(streamError.sessionId, sid)

      yield* Deferred.succeed(gate, undefined)
      const res1 = yield* Fiber.join(fiber1)
      assert.strictEqual(res1, "first")
      assert.strictEqual(yield* registry.isActive(sid), false)
    }),
  )

  it.effect("runs on different sessions execute concurrently", () =>
    Effect.gen(function* () {
      const registry = yield* RunRegistry
      const s1 = SessionId.make("session-1")
      const s2 = SessionId.make("session-2")
      const started1 = yield* Deferred.make<void>()
      const started2 = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()

      const f1 = yield* Effect.forkChild(
        registry.run(s1, () =>
          Deferred.succeed(started1, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.as("val1"),
          ),
        ),
      )
      const f2 = yield* Effect.forkChild(
        registry.run(s2, () =>
          Deferred.succeed(started2, undefined).pipe(
            Effect.andThen(Deferred.await(gate)),
            Effect.as("val2"),
          ),
        ),
      )

      yield* Deferred.await(started1)
      yield* Deferred.await(started2)

      const active = yield* registry.activeSessions
      assert.strictEqual(active.length, 2)
      assert.ok(active.includes(s1))
      assert.ok(active.includes(s2))

      yield* Deferred.succeed(gate, undefined)
      const [r1, r2] = yield* Effect.all([Fiber.join(f1), Fiber.join(f2)])
      assert.strictEqual(r1, "val1")
      assert.strictEqual(r2, "val2")
      assert.strictEqual((yield* registry.activeSessions).length, 0)
    }),
  )

  it.effect("cooperative interrupt signals the running effect and fails on missing session", () =>
    Effect.gen(function* () {
      const registry = yield* RunRegistry
      const sid = SessionId.make("interrupt-sess")

      // Interrupt on non-running session returns RunNotFound
      const exitMissing = yield* Effect.exit(registry.interrupt(sid))
      assert.ok(Exit.isFailure(exitMissing))
      /* SAFETY: Interrupt on inactive session fails with RunNotFound. */
      const notFound = Option.getOrThrow(Exit.findErrorOption(exitMissing)) as RunNotFound
      assert.strictEqual(notFound._tag, "RunNotFound")
      assert.strictEqual(notFound.sessionId, sid)

      const started = yield* Deferred.make<void>()
      const interruptedDeferred = yield* Deferred.make<boolean>()

      const fiber = yield* Effect.forkChild(
        registry.run(sid, (signal) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined)
            yield* signal.await
            const isInt = yield* signal.isInterrupted
            yield* Deferred.succeed(interruptedDeferred, isInt)
            return "done"
          }),
        ),
      )

      yield* Deferred.await(started)
      assert.strictEqual(yield* registry.isActive(sid), true)

      // Interrupt running session
      yield* registry.interrupt(sid)

      const wasInterrupted = yield* Deferred.await(interruptedDeferred)
      assert.strictEqual(wasInterrupted, true)

      const result = yield* Fiber.join(fiber)
      assert.strictEqual(result, "done")
      assert.strictEqual(yield* registry.isActive(sid), false)
    }),
  )

  it.effect("cleans up on typed failure", () =>
    Effect.gen(function* () {
      const registry = yield* RunRegistry
      const sid = SessionId.make("typed-fail")

      class MyError {
        readonly _tag = "MyError"
      }

      const exit = yield* Effect.exit(registry.run(sid, () => Effect.fail(new MyError())))
      assert.ok(Exit.isFailure(exit))
      assert.strictEqual(yield* registry.isActive(sid), false)

      // Can immediately run again
      const result = yield* registry.run(sid, () => Effect.succeed("recovered"))
      assert.strictEqual(result, "recovered")
    }),
  )

  it.effect("cleans up on defect", () =>
    Effect.gen(function* () {
      const registry = yield* RunRegistry
      const sid = SessionId.make("defect-fail")

      const exit = yield* Effect.exit(
        registry.run(sid, () => Effect.die(new Error("unexpected crash"))),
      )
      assert.ok(Exit.isFailure(exit))
      assert.strictEqual(yield* registry.isActive(sid), false)

      // Can immediately run again
      const result = yield* registry.run(sid, () => Effect.succeed("recovered"))
      assert.strictEqual(result, "recovered")
    }),
  )

  it.effect("stream early termination (take) force-interrupts producer and cleans up", () =>
    Effect.gen(function* () {
      const registry = yield* RunRegistry
      const sid = SessionId.make("early-take")
      const producerInterrupted = yield* Deferred.make<void>()

      const stream = registry.runStream(sid, () =>
        Stream.make(1, 2, 3).pipe(
          Stream.concat(
            Stream.fromEffect(
              Effect.never.pipe(
                Effect.onInterrupt(() => Deferred.succeed(producerInterrupted, undefined)),
              ),
            ),
          ),
        ),
      )

      const items = yield* Stream.runCollect(Stream.take(stream, 2))
      assert.deepStrictEqual([...items], [1, 2])

      // Producer fiber was interrupted by the stream scope finalizer
      yield* Deferred.await(producerInterrupted)

      // Session is cleanly available
      assert.strictEqual(yield* registry.isActive(sid), false)
    }),
  )

  it.effect("layer scope closure interrupts all running fibers", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>()
      const interrupted = yield* Deferred.make<void>()
      const sid = SessionId.make("shutdown-test")

      const scope = yield* Scope.make()
      const reg = yield* Scope.provide(make, scope)

      yield* Effect.forkChild(
        reg.run(sid, () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
        ),
      )

      yield* Deferred.await(started)
      assert.strictEqual(yield* reg.isActive(sid), true)

      // Close registry scope
      yield* Scope.close(scope, Exit.void)

      // Verify running fiber was interrupted
      yield* Deferred.await(interrupted)
    }),
  )
})
