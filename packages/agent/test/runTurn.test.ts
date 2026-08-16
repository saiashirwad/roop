import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Ref } from "effect"

import { hooksNoop } from "../src/AgentHooks.ts"
import { resolveRunPolicy } from "../src/RunPolicy.ts"
import { runTurn } from "../src/runTurn.ts"
import type { SessionEvent } from "../src/SessionEvent.ts"
import { SessionId } from "../src/SessionId.ts"

const makeInterruptMock = (isInterrupted = false) => ({
  isInterrupted: Effect.succeed(isInterrupted),
  await: Effect.never,
})

describe("runTurn", () => {
  it.effect("completes single step turn naturally", () =>
    Effect.gen(function* () {
      const sid = SessionId.make("turn-test-1")
      const events = yield* Ref.make<Array<SessionEvent>>([])
      const append = (ev: SessionEvent) => Ref.update(events, (all) => [...all, ev])

      const outcome = yield* runTurn({
        sessionId: sid,
        turn: 1,
        totalSteps: 0,
        policy: resolveRunPolicy({}),
        interrupt: makeInterruptMock(false),
        append,
        hooks: hooksNoop,
        runStep: () => Effect.succeed({ _tag: "Stop", toolCallCount: 0 }),
      })

      assert.strictEqual(outcome._tag, "Stop")
      if (outcome._tag === "Stop") {
        assert.strictEqual(outcome.reason, "completed")
        assert.strictEqual(outcome.stepCount, 1)
        assert.strictEqual(outcome.totalSteps, 1)
      }

      const recorded = yield* Ref.get(events)
      assert.strictEqual(recorded.length, 2)
      assert.deepStrictEqual(recorded[0], { _tag: "turn/start" })
      assert.deepStrictEqual(recorded[1], { _tag: "turn/end", reason: "completed" })
    }),
  )

  it.effect("executes multiple steps when ToolCalls outcome is returned", () =>
    Effect.gen(function* () {
      const sid = SessionId.make("turn-test-2")
      const events = yield* Ref.make<Array<SessionEvent>>([])
      const append = (ev: SessionEvent) => Ref.update(events, (all) => [...all, ev])
      const stepIndex = yield* Ref.make(0)

      const outcome = yield* runTurn({
        sessionId: sid,
        turn: 1,
        totalSteps: 5,
        policy: resolveRunPolicy({}),
        interrupt: makeInterruptMock(false),
        append,
        hooks: hooksNoop,
        runStep: () =>
          Ref.updateAndGet(stepIndex, (i) => i + 1).pipe(
            Effect.map((i) =>
              i < 3
                ? { _tag: "ToolCalls" as const, toolCallCount: 1 }
                : { _tag: "Stop" as const, toolCallCount: 0 },
            ),
          ),
      })

      assert.strictEqual(outcome._tag, "Stop")
      if (outcome._tag === "Stop") {
        assert.strictEqual(outcome.stepCount, 3)
        assert.strictEqual(outcome.totalSteps, 8)
      }
    }),
  )

  it.effect("stops when maxStepsPerTurn limit is reached", () =>
    Effect.gen(function* () {
      const sid = SessionId.make("turn-test-3")
      const events = yield* Ref.make<Array<SessionEvent>>([])
      const append = (ev: SessionEvent) => Ref.update(events, (all) => [...all, ev])

      const outcome = yield* runTurn({
        sessionId: sid,
        turn: 1,
        totalSteps: 0,
        policy: resolveRunPolicy({ maxStepsPerTurn: 2 }),
        interrupt: makeInterruptMock(false),
        append,
        hooks: hooksNoop,
        runStep: () => Effect.succeed({ _tag: "ToolCalls", toolCallCount: 1 }),
      })

      assert.strictEqual(outcome._tag, "LimitReached")
      if (outcome._tag === "LimitReached") {
        assert.strictEqual(outcome.limit, "maxStepsPerTurn")
        assert.strictEqual(outcome.stepCount, 2)
        assert.strictEqual(outcome.totalSteps, 2)
      }

      const recorded = yield* Ref.get(events)
      assert.deepStrictEqual(recorded[recorded.length - 1], {
        _tag: "turn/end",
        reason: "stopped",
      })
    }),
  )

  it.effect("stops when maxTotalSteps limit is reached", () =>
    Effect.gen(function* () {
      const sid = SessionId.make("turn-test-4")
      const events = yield* Ref.make<Array<SessionEvent>>([])
      const append = (ev: SessionEvent) => Ref.update(events, (all) => [...all, ev])

      const outcome = yield* runTurn({
        sessionId: sid,
        turn: 2,
        totalSteps: 9,
        policy: resolveRunPolicy({ maxTotalSteps: 10 }),
        interrupt: makeInterruptMock(false),
        append,
        hooks: hooksNoop,
        runStep: () => Effect.succeed({ _tag: "ToolCalls", toolCallCount: 1 }),
      })

      assert.strictEqual(outcome._tag, "LimitReached")
      if (outcome._tag === "LimitReached") {
        assert.strictEqual(outcome.limit, "maxTotalSteps")
        assert.strictEqual(outcome.stepCount, 1)
        assert.strictEqual(outcome.totalSteps, 10)
      }
    }),
  )

  it.effect("returns Interrupted when interrupt signal is active", () =>
    Effect.gen(function* () {
      const sid = SessionId.make("turn-test-5")
      const events = yield* Ref.make<Array<SessionEvent>>([])
      const append = (ev: SessionEvent) => Ref.update(events, (all) => [...all, ev])

      const outcome = yield* runTurn({
        sessionId: sid,
        turn: 1,
        totalSteps: 0,
        policy: resolveRunPolicy({}),
        interrupt: makeInterruptMock(true),
        append,
        hooks: hooksNoop,
        runStep: () => Effect.succeed({ _tag: "Stop", toolCallCount: 0 }),
      })

      assert.strictEqual(outcome._tag, "Interrupted")
      const recorded = yield* Ref.get(events)
      assert.deepStrictEqual(recorded[recorded.length - 1], {
        _tag: "turn/end",
        reason: "interrupted",
      })
    }),
  )

  it.effect("returns Continue when turnStopping hook provides continuation", () =>
    Effect.gen(function* () {
      const sid = SessionId.make("turn-test-6")
      const events = yield* Ref.make<Array<SessionEvent>>([])
      const append = (ev: SessionEvent) => Ref.update(events, (all) => [...all, ev])

      const outcome = yield* runTurn({
        sessionId: sid,
        turn: 1,
        totalSteps: 0,
        policy: resolveRunPolicy({}),
        interrupt: makeInterruptMock(false),
        append,
        hooks: {
          ...hooksNoop,
          turnStopping: () => Effect.succeed({ prompt: "next prompt from hook" }),
        },
        runStep: () => Effect.succeed({ _tag: "Stop", toolCallCount: 0 }),
      })

      assert.strictEqual(outcome._tag, "Continue")
      if (outcome._tag === "Continue") {
        assert.strictEqual(outcome.prompt, "next prompt from hook")
      }
      const recorded = yield* Ref.get(events)
      assert.deepStrictEqual(recorded[recorded.length - 1], {
        _tag: "turn/end",
        reason: "completed",
      })
    }),
  )

  it.effect("does not append unmatched turn/end when turn/start fails", () =>
    Effect.gen(function* () {
      const sid = SessionId.make("turn-test-start-fail")
      const attempted = yield* Ref.make<Array<SessionEvent>>([])
      const append = (event: SessionEvent) =>
        Ref.update(attempted, (events) => [...events, event]).pipe(
          Effect.andThen(Effect.die(new Error("journal unavailable"))),
        )

      const exit = yield* Effect.exit(
        runTurn({
          sessionId: sid,
          turn: 1,
          totalSteps: 0,
          policy: resolveRunPolicy({}),
          interrupt: makeInterruptMock(false),
          append,
          hooks: hooksNoop,
          runStep: () => Effect.succeed({ _tag: "Stop", toolCallCount: 0 }),
        }),
      )

      assert.ok(Exit.isFailure(exit))
      assert.deepStrictEqual(yield* Ref.get(attempted), [{ _tag: "turn/start" }])
    }),
  )

  it.effect("journals turn/end failed on step error and re-fails", () =>
    Effect.gen(function* () {
      const sid = SessionId.make("turn-test-7")
      const events = yield* Ref.make<Array<SessionEvent>>([])
      const append = (ev: SessionEvent) => Ref.update(events, (all) => [...all, ev])

      class StepError {
        readonly _tag = "StepError"
      }

      const exit = yield* Effect.exit(
        runTurn({
          sessionId: sid,
          turn: 1,
          totalSteps: 0,
          policy: resolveRunPolicy({}),
          interrupt: makeInterruptMock(false),
          append,
          hooks: hooksNoop,
          runStep: () => Effect.fail(new StepError()),
        }),
      )

      assert.ok(Exit.isFailure(exit))
      const recorded = yield* Ref.get(events)
      assert.ok(recorded.length > 0)
      const last = recorded[recorded.length - 1]
      assert.ok(last !== undefined)
      assert.strictEqual(last._tag, "turn/end")
      if (last._tag === "turn/end") {
        assert.strictEqual(last.reason, "failed")
      }
    }),
  )
})
