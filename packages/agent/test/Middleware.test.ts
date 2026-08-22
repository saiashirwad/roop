import { assert, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Layer, Ref, Stream } from "effect"
import { Prompt } from "effect/unstable/ai"

import * as Middleware from "../src/Middleware.ts"

const stepInput: Middleware.StepRunInput = {
  sessionId: "middleware",
  turn: 1,
  step: 1,
  stepIndex: 1,
}

it.effect("runs leftmost middleware outermost", () =>
  Effect.gen(function* () {
    const order: string[] = []
    const stage = (name: string) =>
      Middleware.make({
        step: (next) => (input) =>
          Effect.gen(function* () {
            order.push(`${name}:in`)
            const value = yield* next(input)
            order.push(`${name}:out`)
            return value
          }),
      })
    const stack = Middleware.all(stage("outer"), stage("inner"))
    const result = yield* stack.step(() => Effect.succeed("ok"))(stepInput)
    assert.strictEqual(result, "ok")
    assert.deepStrictEqual(order, ["outer:in", "inner:in", "inner:out", "outer:out"])
  }),
)

it.effect("preserves typed failures through nested middleware", () =>
  Effect.gen(function* () {
    const observed: string[] = []
    const stage = (name: string) =>
      Middleware.make({
        step: (next) => (input) =>
          next(input).pipe(Effect.tapError(() => Effect.sync(() => observed.push(name)))),
      })
    const stack = Middleware.all(stage("outer"), stage("inner"))
    const exit = yield* Effect.exit(stack.step(() => Effect.fail("typed"))(stepInput))
    assert.ok(Exit.isFailure(exit))
    assert.deepStrictEqual(observed, ["inner", "outer"])
  }),
)

it.effect("runs middleware cleanup for defects", () =>
  Effect.gen(function* () {
    const finalized: string[] = []
    const stage = (name: string) =>
      Middleware.make({
        step: (next) => (input) =>
          next(input).pipe(Effect.ensuring(Effect.sync(() => finalized.push(name)))),
      })
    const stack = Middleware.all(stage("outer"), stage("inner"))
    const exit = yield* Effect.exit(stack.step(() => Effect.die("defect"))(stepInput))
    assert.ok(Exit.isFailure(exit))
    assert.deepStrictEqual(finalized, ["inner", "outer"])
  }),
)

it.effect("uses the same outermost-first order at every boundary", () =>
  Effect.gen(function* () {
    const order: string[] = []
    const stage = (name: string, boundary: string) =>
      Middleware.make({
        model: (next) => (input) =>
          Stream.fromEffect(Effect.sync(() => order.push(`${boundary}:${name}:in`))).pipe(
            Stream.drain,
            Stream.concat(next(input)),
            Stream.ensuring(Effect.sync(() => order.push(`${boundary}:${name}:out`))),
          ),
        tool: (next) => (input) =>
          Stream.fromEffect(Effect.sync(() => order.push(`${boundary}:${name}:in`))).pipe(
            Stream.drain,
            Stream.concat(next(input)),
            Stream.ensuring(Effect.sync(() => order.push(`${boundary}:${name}:out`))),
          ),
        step: (next) => (input) =>
          Effect.sync(() => order.push(`${boundary}:${name}:in`)).pipe(
            Effect.andThen(next(input)),
            Effect.ensuring(Effect.sync(() => order.push(`${boundary}:${name}:out`))),
          ),
        turn: (next) => (input) =>
          Effect.sync(() => order.push(`${boundary}:${name}:in`)).pipe(
            Effect.andThen(next(input)),
            Effect.ensuring(Effect.sync(() => order.push(`${boundary}:${name}:out`))),
          ),
      })

    for (const boundary of ["model", "tool", "step", "turn"] as const) {
      const stack = Middleware.all(stage("outer", boundary), stage("inner", boundary))
      if (boundary === "model") {
        yield* stack
          .model(() => Stream.make("ok"))({
            sessionId: "middleware",
            turn: 1,
            step: 1,
            prompt: Prompt.empty,
            attempt: 1,
          })
          .pipe(Stream.runDrain)
      } else if (boundary === "tool") {
        yield* stack
          .tool(() => Stream.make("ok"))({
            sessionId: "middleware",
            turn: 1,
            step: 1,
            name: "tool",
            params: {},
          })
          .pipe(Stream.runDrain)
      } else if (boundary === "step") {
        yield* stack.step(() => Effect.succeed("ok"))(stepInput)
      } else {
        yield* stack.turn(() => Effect.succeed("ok"))({
          sessionId: "middleware",
          turn: 1,
          step: 1,
          stepCount: 1,
        })
      }
      assert.deepStrictEqual(order.splice(0), [
        `${boundary}:outer:in`,
        `${boundary}:inner:in`,
        `${boundary}:inner:out`,
        `${boundary}:outer:out`,
      ])
    }
  }),
)

it.effect("runs nested cleanup from inner to outer on interruption", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const finalized: string[] = []
    const stage = (name: string) =>
      Middleware.make({
        step: (next) => (input) =>
          next(input).pipe(Effect.ensuring(Effect.sync(() => finalized.push(name)))),
      })
    const stack = Middleware.all(stage("outer"), stage("inner"))
    const fiber = yield* stack
      .step(() => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))(
        stepInput,
      )
      .pipe(Effect.forkChild)
    yield* Deferred.await(started)
    yield* Fiber.interrupt(fiber)
    assert.deepStrictEqual(finalized, ["inner", "outer"])
  }),
)

it.effect("wraps a tool stream for its full cancellation lifetime", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const finalized = yield* Ref.make(0)
    const stack = Middleware.make({
      tool: (next) => (input) =>
        next(input).pipe(Stream.ensuring(Ref.update(finalized, (count) => count + 1))),
    })
    const stream = stack.tool(() =>
      Stream.fromEffect(Deferred.succeed(started, undefined)).pipe(Stream.concat(Stream.never)),
    )({ sessionId: "middleware", turn: 1, step: 1, name: "slow", params: {} })
    const fiber = yield* Stream.runDrain(stream).pipe(Effect.forkChild)
    yield* Deferred.await(started)
    yield* Fiber.interrupt(fiber)
    assert.strictEqual(yield* Ref.get(finalized), 1)
  }),
)

it.effect("interrupts model fallback waiting without starting another attempt", () =>
  Effect.gen(function* () {
    const waiting = yield* Deferred.make<void>()
    const finalized = yield* Ref.make(0)
    const stack = Middleware.make({
      model: (next) => (input) =>
        next(input).pipe(
          Stream.catchCause(() =>
            Stream.fromEffect(Deferred.succeed(waiting, undefined)).pipe(
              Stream.drain,
              Stream.concat(Stream.never),
              Stream.ensuring(Ref.update(finalized, (count) => count + 1)),
            ),
          ),
        ),
    })
    const stream = stack.model(() => Stream.fail("primary"))({
      sessionId: "middleware",
      turn: 1,
      step: 1,
      prompt: Prompt.empty,
      attempt: 1,
    })
    const fiber = yield* Stream.runDrain(stream).pipe(Effect.forkChild)
    yield* Deferred.await(waiting)
    yield* Fiber.interrupt(fiber)
    assert.strictEqual(yield* Ref.get(finalized), 1)
  }),
)

it.effect("releases scoped middleware resources with its Layer", () =>
  Effect.gen(function* () {
    const finalized = yield* Ref.make(0)
    const scoped = Middleware.layerScoped(
      "test",
      Effect.acquireRelease(Effect.succeed(Middleware.empty), () =>
        Ref.update(finalized, (count) => count + 1),
      ),
    )
    yield* Layer.build(scoped).pipe(Effect.scoped)
    assert.strictEqual(yield* Ref.get(finalized), 1)
  }),
)
