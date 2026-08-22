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

it.effect("propagates rewritten tool parameters to the tool handler", () =>
  Effect.gen(function* () {
    const observedParams = yield* Ref.make<unknown>(undefined)
    const mw = Middleware.make({
      tool: (next) => (input) => {
        /* SAFETY: test input parameters match the explicit fixture structure. */
        const params = input.params as { readonly original: string }
        return next({
          ...input,
          params: {
            ...params,
            injected: "added-by-middleware",
          },
        })
      },
    })
    const handler = (input: Middleware.ToolCallInput) =>
      Stream.fromEffect(Ref.set(observedParams, input.params).pipe(Effect.as("done")))

    yield* mw
      .tool(handler)({
        sessionId: "mw-session",
        turn: 1,
        step: 1,
        name: "test_tool",
        params: { original: "initial" },
      })
      .pipe(Stream.runDrain)

    assert.deepStrictEqual(yield* Ref.get(observedParams), {
      original: "initial",
      injected: "added-by-middleware",
    })
  }),
)

it.effect("wraps the entire turn execution with turn middleware", () =>
  Effect.gen(function* () {
    const events: string[] = []
    const mw = Middleware.make({
      turn: (next) => (input) =>
        Effect.gen(function* () {
          events.push("turn:start")
          const res = yield* next(input)
          events.push("turn:end")
          return res
        }),
    })

    const runTurn = (_input: Middleware.TurnRunInput) =>
      Effect.gen(function* () {
        events.push("turn:executing")
        return { _tag: "Completed" as const, stepCount: 1 }
      })

    yield* mw.turn(runTurn)({
      sessionId: "turn-session",
      turn: 1,
      step: 0,
      stepCount: 0,
    })

    assert.deepStrictEqual(events, ["turn:start", "turn:executing", "turn:end"])
  }),
)
