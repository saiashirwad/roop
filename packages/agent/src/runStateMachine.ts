import type { ResolvedRunPolicy } from "./RunPolicy.ts"

export type RunTerminal = "completed" | "interrupted" | "stopped"

export interface RunState {
  readonly turn: number
  readonly totalSteps: number
  readonly step: number
  readonly phase: "idle" | "running"
  readonly terminal: RunTerminal | undefined
  readonly policy: Pick<ResolvedRunPolicy, "maxTurns" | "maxStepsPerTurn" | "maxTotalSteps">
}

export type RunSignal =
  | { readonly _tag: "StartTurn" }
  | { readonly _tag: "StepCompleted"; readonly toolCalls: number }
  | { readonly _tag: "TurnCompleted"; readonly continuation: boolean }
  | { readonly _tag: "Interrupted" }
  | { readonly _tag: "Stop" }
  | {
      readonly _tag: "LimitReached"
      readonly limit: "maxTurns" | "maxStepsPerTurn" | "maxTotalSteps"
    }

export type RunCommand =
  | { readonly _tag: "StartTurn"; readonly turn: number }
  | { readonly _tag: "RunStep"; readonly turn: number; readonly step: number }
  | { readonly _tag: "Continue" }
  | { readonly _tag: "Finish"; readonly reason: RunTerminal }

export interface Decision {
  readonly state: RunState
  readonly commands: ReadonlyArray<RunCommand>
}

const terminal = (state: RunState, reason: RunTerminal): Decision => ({
  state: { ...state, terminal: reason },
  commands: [{ _tag: "Finish", reason }],
})

/** Internal pure state transition for run orchestration. */
export const transition = (state: RunState, signal: RunSignal): Decision => {
  if (state.terminal !== undefined) return { state, commands: [] }

  switch (signal._tag) {
    case "StartTurn":
      if (state.phase !== "idle") return { state, commands: [] }
      if (state.turn >= state.policy.maxTurns) return terminal(state, "stopped")
      return {
        state: { ...state, turn: state.turn + 1, step: 0, phase: "running" },
        commands: [
          { _tag: "StartTurn", turn: state.turn + 1 },
          { _tag: "RunStep", turn: state.turn + 1, step: 1 },
        ],
      }
    case "StepCompleted": {
      if (state.phase !== "running" || signal.toolCalls < 0) return { state, commands: [] }
      if (
        state.totalSteps >= state.policy.maxTotalSteps ||
        state.step >= state.policy.maxStepsPerTurn
      )
        return terminal(state, "stopped")
      const next = { ...state, step: state.step + 1, totalSteps: state.totalSteps + 1 }
      if (
        next.totalSteps >= state.policy.maxTotalSteps ||
        next.step >= state.policy.maxStepsPerTurn
      ) {
        return signal.toolCalls > 0 ? terminal(next, "stopped") : { state: next, commands: [] }
      }
      return {
        state: next,
        commands:
          signal.toolCalls > 0 ? [{ _tag: "RunStep", turn: next.turn, step: next.step + 1 }] : [],
      }
    }
    case "TurnCompleted":
      if (state.phase !== "running") return { state, commands: [] }
      if (!signal.continuation) return terminal(state, "completed")
      // A continuation is only valid when another turn can actually start.
      if (state.turn >= state.policy.maxTurns || state.totalSteps >= state.policy.maxTotalSteps) {
        return terminal({ ...state, phase: "idle" }, "stopped")
      }
      return { state: { ...state, phase: "idle" }, commands: [{ _tag: "Continue" }] }
    case "Interrupted":
      return terminal(state, "interrupted")
    case "Stop":
      return terminal(state, "completed")
    case "LimitReached":
      return terminal(state, "stopped")
  }
}

export const initialRunState = (policy: RunState["policy"]): RunState => ({
  turn: 0,
  totalSteps: 0,
  step: 0,
  phase: "idle",
  terminal: undefined,
  policy,
})
