import { assert, it } from "@effect/vitest"

import { initialRunState, transition, type RunState } from "../src/RunMachine.ts"

const policy: RunState["policy"] = { maxTurns: 2, maxStepsPerTurn: 2, maxTotalSteps: 3 }

it("RunMachine transitions deterministically and preserves terminal finality", () => {
  const initial = initialRunState(policy)
  const started = transition(initial, { _tag: "StartTurn" })
  assert.deepStrictEqual(started.state.turn, 1)
  assert.deepStrictEqual(started.commands, [
    { _tag: "StartTurn", turn: 1 },
    { _tag: "RunStep", turn: 1, step: 1 },
  ])
  assert.deepStrictEqual(transition(started.state, { _tag: "StartTurn" }).commands, [])

  const done = transition(started.state, { _tag: "TurnCompleted", continuation: false })
  assert.strictEqual(done.state.terminal, "completed")
  assert.deepStrictEqual(transition(done.state, { _tag: "StartTurn" }), {
    state: done.state,
    commands: [],
  })
})

it("RunMachine enforces turn and step bounds", () => {
  const atTurnLimit = { ...initialRunState(policy), turn: 2 }
  assert.strictEqual(transition(atTurnLimit, { _tag: "StartTurn" }).state.terminal, "stopped")

  const started = transition(initialRunState(policy), { _tag: "StartTurn" }).state
  const first = transition(started, { _tag: "StepCompleted", toolCalls: 1 }).state
  const second = transition(first, { _tag: "StepCompleted", toolCalls: 1 })
  assert.strictEqual(second.state.terminal, "stopped")
  assert.deepStrictEqual(second.commands, [{ _tag: "Finish", reason: "stopped" }])
  assert.ok(second.state.totalSteps <= policy.maxTotalSteps)
  assert.ok(second.state.step <= policy.maxStepsPerTurn)
  assert.deepStrictEqual(
    transition(initialRunState(policy), { _tag: "StepCompleted", toolCalls: 1 }),
    {
      state: initialRunState(policy),
      commands: [],
    },
  )
})

it("RunMachine handles interruption and stop without orphaned commands", () => {
  const state = transition(initialRunState(policy), { _tag: "StartTurn" }).state
  for (const signal of [{ _tag: "Interrupted" } as const, { _tag: "Stop" } as const]) {
    const decision = transition(state, signal)
    assert.strictEqual(
      decision.state.terminal,
      signal._tag === "Stop" ? "completed" : "interrupted",
    )
    assert.deepStrictEqual(decision.commands.length, 1)
    assert.strictEqual(decision.commands[0]!._tag, "Finish")
  }
})

it("RunMachine preserves invariants across exhaustive bounded signal sequences", () => {
  const signals = [
    { _tag: "StartTurn" as const },
    { _tag: "StepCompleted" as const, toolCalls: 0 },
    { _tag: "StepCompleted" as const, toolCalls: 1 },
    { _tag: "TurnCompleted" as const, continuation: false },
    { _tag: "TurnCompleted" as const, continuation: true },
    { _tag: "Interrupted" as const },
    { _tag: "Stop" as const },
    { _tag: "LimitReached" as const, limit: "maxTurns" as const },
  ]
  const policies = [
    { maxTurns: 1, maxStepsPerTurn: 1, maxTotalSteps: 1 },
    { maxTurns: 2, maxStepsPerTurn: 2, maxTotalSteps: 3 },
  ]
  const visit = (state: RunState, depth: number): void => {
    if (depth === 0) return
    for (const signal of signals) {
      const decision = transition(state, signal)
      assert.deepStrictEqual(decision, transition(state, signal))
      assert.ok(decision.state.turn <= decision.state.policy.maxTurns)
      assert.ok(decision.state.step <= decision.state.policy.maxStepsPerTurn)
      assert.ok(decision.state.totalSteps <= decision.state.policy.maxTotalSteps)
      for (const command of decision.commands) {
        if (command._tag === "StartTurn" || command._tag === "RunStep") assert.ok(command.turn > 0)
        if (command._tag === "RunStep") assert.ok(command.step > 0)
      }
      if (state.terminal !== undefined) assert.deepStrictEqual(decision, { state, commands: [] })
      if (decision.state.terminal !== undefined)
        assert.deepStrictEqual(transition(decision.state, signal), {
          state: decision.state,
          commands: [],
        })
      visit(decision.state, depth - 1)
    }
  }
  for (const smallPolicy of policies) visit(initialRunState(smallPolicy), 4)
})
