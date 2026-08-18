import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Layer, Option } from "effect"

import { AgentHooks, layerNoop, type RunContext, type ToolCallInfo } from "../src/AgentHooks.ts"
import { layerDoomLoopGuard } from "../src/DoomLoopGuard.ts"

describe("DoomLoopGuard", () => {
  const dummyContext: RunContext = {
    sessionId: "test-session",
    turn: 1,
    step: 1,
  }

  it.effect("admits unique and varying tool calls", () =>
    Effect.gen(function* () {
      const hooks = yield* AgentHooks

      const call1: ToolCallInfo = { name: "readFile", params: { path: "a.ts" } }
      const call2: ToolCallInfo = { name: "readFile", params: { path: "b.ts" } }
      const call3: ToolCallInfo = { name: "writeFile", params: { path: "a.ts", content: "hi" } }

      const res1 = yield* hooks.beforeToolExecute(dummyContext, call1)
      const res2 = yield* hooks.beforeToolExecute(dummyContext, call2)
      const res3 = yield* hooks.beforeToolExecute(dummyContext, call3)

      assert.deepStrictEqual(res1, call1)
      assert.deepStrictEqual(res2, call2)
      assert.deepStrictEqual(res3, call3)
    }).pipe(
      Effect.provide(
        layerDoomLoopGuard({ maxConsecutiveIdenticalCalls: 3 }).pipe(Layer.provideMerge(layerNoop)),
      ),
    ),
  )

  it.effect("rejects consecutive identical tool calls after threshold is reached", () =>
    Effect.gen(function* () {
      const hooks = yield* AgentHooks
      const call: ToolCallInfo = { name: "readFile", params: { path: "nonexistent.ts" } }

      // Call 1: Admitted
      yield* hooks.beforeToolExecute(dummyContext, call)
      // Call 2: Admitted
      yield* hooks.beforeToolExecute(dummyContext, call)

      // Call 3: Rejected with ToolRejected
      const exit = yield* Effect.exit(hooks.beforeToolExecute(dummyContext, call))
      assert.ok(Exit.isFailure(exit))
      // SAFETY: the preceding assertion proves this exit contains the ToolRejected error under test.
      const error = Option.getOrThrow(Exit.findErrorOption(exit)) as any
      assert.strictEqual(error._tag, "ToolRejected")
      assert.match(error.reason, /Doom loop detected/)
    }).pipe(
      Effect.provide(
        layerDoomLoopGuard({ maxConsecutiveIdenticalCalls: 3 }).pipe(Layer.provideMerge(layerNoop)),
      ),
    ),
  )

  it.effect("handles object parameter key order canonicalization", () =>
    Effect.gen(function* () {
      const hooks = yield* AgentHooks

      // Keys in different order, but identical semantics
      const callA: ToolCallInfo = { name: "grep", params: { pattern: "foo", path: "src" } }
      const callB: ToolCallInfo = { name: "grep", params: { path: "src", pattern: "foo" } }

      yield* hooks.beforeToolExecute(dummyContext, callA)
      yield* hooks.beforeToolExecute(dummyContext, callB)

      const exit = yield* Effect.exit(hooks.beforeToolExecute(dummyContext, callA))
      assert.ok(Exit.isFailure(exit))
      // SAFETY: the preceding assertion proves this exit contains the ToolRejected error under test.
      const error = Option.getOrThrow(Exit.findErrorOption(exit)) as any
      assert.strictEqual(error._tag, "ToolRejected")
      assert.match(error.reason, /Doom loop detected/)
    }).pipe(
      Effect.provide(
        layerDoomLoopGuard({ maxConsecutiveIdenticalCalls: 3 }).pipe(Layer.provideMerge(layerNoop)),
      ),
    ),
  )

  it.effect("detects and rejects repeating alternating cycles (A -> B -> A -> B -> A -> B)", () =>
    Effect.gen(function* () {
      const hooks = yield* AgentHooks

      const callA: ToolCallInfo = { name: "readFile", params: { path: "a.ts" } }
      const callB: ToolCallInfo = { name: "readFile", params: { path: "b.ts" } }

      // Repetition 1
      yield* hooks.beforeToolExecute(dummyContext, callA)
      yield* hooks.beforeToolExecute(dummyContext, callB)

      // Repetition 2
      yield* hooks.beforeToolExecute(dummyContext, callA)
      yield* hooks.beforeToolExecute(dummyContext, callB)

      // Repetition 3 (triggers cycle detection on next entry)
      yield* hooks.beforeToolExecute(dummyContext, callA)
      const exit = yield* Effect.exit(hooks.beforeToolExecute(dummyContext, callB))

      assert.ok(Exit.isFailure(exit))
      // SAFETY: the preceding assertion proves this exit contains the ToolRejected error under test.
      const error = Option.getOrThrow(Exit.findErrorOption(exit)) as any
      assert.strictEqual(error._tag, "ToolRejected")
      assert.match(error.reason, /Doom cycle detected/)
    }).pipe(
      Effect.provide(
        layerDoomLoopGuard({
          maxConsecutiveIdenticalCalls: 5,
          maxCycleRepetitions: 3,
        }).pipe(Layer.provideMerge(layerNoop)),
      ),
    ),
  )

  it.effect("detects and rejects repeating three-step cycles", () =>
    Effect.gen(function* () {
      const hooks = yield* AgentHooks
      const calls: ReadonlyArray<ToolCallInfo> = [
        { name: "readFile", params: { path: "a.ts" } },
        { name: "grep", params: { pattern: "TODO" } },
        { name: "readFile", params: { path: "b.ts" } },
      ]

      for (const call of [...calls, ...calls, ...calls].slice(0, 8)) {
        yield* hooks.beforeToolExecute(dummyContext, call!)
      }

      const exit = yield* Effect.exit(hooks.beforeToolExecute(dummyContext, calls[2]!))
      assert.ok(Exit.isFailure(exit))
      // SAFETY: the preceding assertion proves this exit contains the ToolRejected error under test.
      const error = Option.getOrThrow(Exit.findErrorOption(exit)) as any
      assert.strictEqual(error._tag, "ToolRejected")
      assert.match(error.reason, /sequence of 3 alternating tool calls/)
    }).pipe(
      Effect.provide(
        layerDoomLoopGuard({
          maxConsecutiveIdenticalCalls: 5,
          maxCycleRepetitions: 3,
        }).pipe(Layer.provideMerge(layerNoop)),
      ),
    ),
  )

  it.effect("keeps histories isolated by session", () =>
    Effect.gen(function* () {
      const hooks = yield* AgentHooks
      const call: ToolCallInfo = { name: "readFile", params: { path: "same.ts" } }
      const otherSession = { ...dummyContext, sessionId: "another-session" }

      yield* hooks.beforeToolExecute(dummyContext, call)
      yield* hooks.beforeToolExecute(dummyContext, call)
      yield* hooks.beforeToolExecute(otherSession, call)
    }).pipe(
      Effect.provide(
        layerDoomLoopGuard({ maxConsecutiveIdenticalCalls: 3 }).pipe(Layer.provideMerge(layerNoop)),
      ),
    ),
  )

  it.effect(
    "does not confuse long streaks with alternating cycles when maxConsecutiveIdenticalCalls is high",
    () =>
      Effect.gen(function* () {
        const hooks = yield* AgentHooks
        const call: ToolCallInfo = { name: "readFile", params: { path: "a.ts" } }
        // 5 consecutive identical calls with maxConsecutiveIdenticalCalls = 10 and maxCycleRepetitions = 2
        for (let i = 0; i < 5; i++) {
          yield* hooks.beforeToolExecute(dummyContext, call)
        }
      }).pipe(
        Effect.provide(
          layerDoomLoopGuard({
            maxConsecutiveIdenticalCalls: 10,
            maxCycleRepetitions: 2,
          }).pipe(Layer.provideMerge(layerNoop)),
        ),
      ),
  )
})
