import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Ref, Stream } from "effect"

import { makeToolScheduler } from "../src/internal/toolScheduler.ts"

describe("ToolScheduler", () => {
  it.effect("unbounded scheduler runs tasks immediately without restriction", () =>
    Effect.gen(function* () {
      const scheduler = yield* makeToolScheduler("unbounded")
      const active = yield* Ref.make(0)
      const maxActive = yield* Ref.make(0)
      const gate = yield* Deferred.make<void>()
      const started1 = yield* Deferred.make<void>()
      const started2 = yield* Deferred.make<void>()

      const makeStream = (onStart: Deferred.Deferred<void>) =>
        scheduler.schedule(
          Stream.fromEffect(
            Ref.updateAndGet(active, (n) => n + 1).pipe(
              Effect.tap((n) => Ref.update(maxActive, (max) => Math.max(max, n))),
              Effect.tap(() => Deferred.succeed(onStart, undefined)),
            ),
          ).pipe(
            Stream.flatMap(() => Stream.fromEffect(Deferred.await(gate))),
            Stream.ensuring(Ref.update(active, (n) => n - 1)),
          ),
        )

      const f1 = yield* Effect.forkChild(Stream.runCollect(makeStream(started1)))
      const f2 = yield* Effect.forkChild(Stream.runCollect(makeStream(started2)))

      yield* Deferred.await(started1)
      yield* Deferred.await(started2)

      assert.strictEqual(yield* Ref.get(maxActive), 2)
      assert.strictEqual(yield* Ref.get(active), 2)

      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(f1)
      yield* Fiber.join(f2)

      assert.strictEqual(yield* Ref.get(active), 0)
    }),
  )

  it.effect("concurrency 1 restricts execution to at most one at a time", () =>
    Effect.gen(function* () {
      const scheduler = yield* makeToolScheduler(1)
      const active = yield* Ref.make(0)
      const maxActive = yield* Ref.make(0)
      const gate1 = yield* Deferred.make<void>()
      const gate2 = yield* Deferred.make<void>()
      const started1 = yield* Deferred.make<void>()
      const started2 = yield* Deferred.make<void>()

      const makeStream = (onStart: Deferred.Deferred<void>, gate: Deferred.Deferred<void>) =>
        scheduler.schedule(
          Stream.fromEffect(
            Ref.updateAndGet(active, (n) => n + 1).pipe(
              Effect.tap((n) => Ref.update(maxActive, (max) => Math.max(max, n))),
              Effect.tap(() => Deferred.succeed(onStart, undefined)),
            ),
          ).pipe(
            Stream.flatMap(() => Stream.fromEffect(Deferred.await(gate))),
            Stream.ensuring(Ref.update(active, (n) => n - 1)),
          ),
        )

      const f1 = yield* Effect.forkChild(Stream.runCollect(makeStream(started1, gate1)))
      const f2 = yield* Effect.forkChild(Stream.runCollect(makeStream(started2, gate2)))

      yield* Deferred.await(started1)
      assert.strictEqual(yield* Ref.get(maxActive), 1)
      assert.strictEqual(yield* Ref.get(active), 1)

      // f2 should not have started because f1 holds the permit
      assert.strictEqual(yield* Deferred.isDone(started2), false)

      // Complete f1 so f2 can acquire permit
      yield* Deferred.succeed(gate1, undefined)
      yield* Fiber.join(f1)

      yield* Deferred.await(started2)
      assert.strictEqual(yield* Ref.get(maxActive), 1)
      assert.strictEqual(yield* Ref.get(active), 1)

      yield* Deferred.succeed(gate2, undefined)
      yield* Fiber.join(f2)

      assert.strictEqual(yield* Ref.get(active), 0)
    }),
  )

  it.effect("acquires permit before starting the handler effect", () =>
    Effect.gen(function* () {
      const scheduler = yield* makeToolScheduler(1)
      const started1 = yield* Deferred.make<void>()
      const started2 = yield* Deferred.make<void>()

      const stream1 = scheduler.scheduleEffect(
        Deferred.succeed(started1, undefined).pipe(Effect.as(Stream.fromEffect(Effect.never))),
      )
      const stream2 = scheduler.scheduleEffect(
        Deferred.succeed(started2, undefined).pipe(Effect.as(Stream.empty)),
      )

      const f1 = yield* Effect.forkChild(Stream.runCollect(stream1))
      yield* Deferred.await(started1)
      const f2 = yield* Effect.forkChild(Stream.runCollect(stream2))
      assert.strictEqual(yield* Deferred.isDone(started2), false)

      yield* Fiber.interrupt(f1)
      yield* Deferred.await(started2)
      yield* Fiber.join(f2)
    }),
  )

  it.effect("permit is held across the entire stream consumption lifetime", () =>
    Effect.gen(function* () {
      const scheduler = yield* makeToolScheduler(1)
      const permitHeld = yield* Ref.make(false)
      const gate = yield* Deferred.make<void>()
      const item1Produced = yield* Deferred.make<void>()
      const started2 = yield* Deferred.make<void>()

      const stream1 = scheduler.schedule(
        Stream.make(1, 2).pipe(
          Stream.tap((item) =>
            item === 1 ? Deferred.succeed(item1Produced, undefined) : Effect.void,
          ),
          Stream.flatMap((item) =>
            Stream.fromEffect(
              Deferred.await(gate).pipe(
                Effect.as(item),
                Effect.onInterrupt(() => Ref.set(permitHeld, false)),
              ),
            ),
          ),
        ),
      )

      const stream2 = scheduler.schedule(Stream.fromEffect(Deferred.succeed(started2, undefined)))

      const f1 = yield* Effect.forkChild(Stream.runCollect(stream1))
      yield* Deferred.await(item1Produced)

      // Stream 2 should still be waiting
      const f2 = yield* Effect.forkChild(Stream.runCollect(stream2))
      assert.strictEqual(yield* Deferred.isDone(started2), false)

      // Unblock stream 1
      yield* Deferred.succeed(gate, undefined)
      const items = yield* Fiber.join(f1)
      assert.deepStrictEqual([...items], [1, 2])

      // Now stream 2 executes
      yield* Deferred.await(started2)
      yield* Fiber.join(f2)
    }),
  )

  it.effect("cancellation/interruption releases permit immediately", () =>
    Effect.gen(function* () {
      const scheduler = yield* makeToolScheduler(1)
      const started1 = yield* Deferred.make<void>()
      const started2 = yield* Deferred.make<void>()

      const stream1 = scheduler.schedule(
        Stream.fromEffect(Deferred.succeed(started1, undefined)).pipe(
          Stream.flatMap(() => Stream.fromEffect(Effect.never)),
        ),
      )

      const stream2 = scheduler.schedule(Stream.fromEffect(Deferred.succeed(started2, undefined)))

      const f1 = yield* Effect.forkChild(Stream.runCollect(stream1))
      yield* Deferred.await(started1)

      const f2 = yield* Effect.forkChild(Stream.runCollect(stream2))
      assert.strictEqual(yield* Deferred.isDone(started2), false)

      // Interrupt f1
      yield* Fiber.interrupt(f1)

      // f2 should acquire permit and start
      yield* Deferred.await(started2)
      yield* Fiber.join(f2)
    }),
  )

  it.effect("failure releases permit immediately", () =>
    Effect.gen(function* () {
      const scheduler = yield* makeToolScheduler(1)
      const started2 = yield* Deferred.make<void>()

      class ToolError {
        readonly _tag = "ToolError"
      }

      const stream1 = scheduler.schedule(Stream.fail(new ToolError()))

      const stream2 = scheduler.schedule(Stream.fromEffect(Deferred.succeed(started2, undefined)))

      const exit1 = yield* Effect.exit(Stream.runCollect(stream1))
      assert.ok(Exit.isFailure(exit1))

      // f2 can now run
      const f2 = yield* Effect.forkChild(Stream.runCollect(stream2))
      yield* Deferred.await(started2)
      yield* Fiber.join(f2)
    }),
  )
})
