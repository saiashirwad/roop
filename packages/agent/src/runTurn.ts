import { Cause, Effect } from "effect"

import type { AgentHooksInterface, RunContext } from "./AgentHooks.ts"
import { RunError } from "./RunError.ts"
import type { ResolvedRunPolicy } from "./RunPolicy.ts"
import type { InterruptSignal } from "./RunRegistry.ts"
import type { StepOutcome } from "./runStep.ts"
import type { SessionEvent } from "./SessionEvent.ts"
import type { SessionId } from "./SessionId.ts"

export type TurnLimit = "maxStepsPerTurn" | "maxTotalSteps"

export type TurnOutcome =
  | {
      readonly _tag: "Stop"
      readonly reason: "completed"
      readonly stepCount: number
      readonly totalSteps: number
    }
  | {
      readonly _tag: "Continue"
      readonly prompt: string
      readonly stepCount: number
      readonly totalSteps: number
    }
  | {
      readonly _tag: "Interrupted"
      readonly stepCount: number
      readonly totalSteps: number
    }
  | {
      readonly _tag: "LimitReached"
      readonly limit: TurnLimit
      readonly stepCount: number
      readonly totalSteps: number
    }

export interface RunTurnOptions<E = never> {
  readonly sessionId: SessionId | string
  readonly turn: number
  readonly totalSteps: number
  readonly policy: ResolvedRunPolicy
  readonly interrupt: InterruptSignal
  readonly append: (event: SessionEvent) => Effect.Effect<void, RunError>
  readonly hooks: AgentHooksInterface
  readonly runStep: (options: {
    readonly turn: number
    readonly step: number
  }) => Effect.Effect<StepOutcome, E>
}

/**
 * Coordinates multiple steps within a single turn under turn and total step limits.
 */
export const runTurn = <E = never>(options: RunTurnOptions<E>): Effect.Effect<TurnOutcome, E | RunError> => {
  let started = false
  let closed = false

  const execution = Effect.gen(function* () {
    yield* options.append({ _tag: "turn/start" })
    started = true

    let step = 0
    let currentTotalSteps = options.totalSteps

    while (true) {
      if (yield* options.interrupt.isInterrupted) {
        yield* options.append({ _tag: "turn/end", reason: "interrupted" })
        closed = true
        return {
          _tag: "Interrupted" as const,
          stepCount: step,
          totalSteps: currentTotalSteps,
        }
      }

      if (currentTotalSteps >= options.policy.maxTotalSteps) {
        yield* options.append({ _tag: "turn/end", reason: "stopped" })
        closed = true
        return {
          _tag: "LimitReached" as const,
          limit: "maxTotalSteps" as const,
          stepCount: step,
          totalSteps: currentTotalSteps,
        }
      }

      if (step >= options.policy.maxStepsPerTurn) {
        yield* options.append({ _tag: "turn/end", reason: "stopped" })
        closed = true
        return {
          _tag: "LimitReached" as const,
          limit: "maxStepsPerTurn" as const,
          stepCount: step,
          totalSteps: currentTotalSteps,
        }
      }

      step += 1
      currentTotalSteps += 1

      const outcome = yield* options.runStep({
        turn: options.turn,
        step,
      })

      if (outcome._tag === "Interrupted") {
        yield* options.append({ _tag: "turn/end", reason: "interrupted" })
        closed = true
        return {
          _tag: "Interrupted" as const,
          stepCount: step,
          totalSteps: currentTotalSteps,
        }
      }

      if (outcome._tag === "Stop") {
        break
      }
      // If outcome._tag === "ToolCalls", continue to next step in the loop
    }

    const context: RunContext = {
      sessionId: options.sessionId,
      turn: options.turn,
      step,
    }

    const continuation = yield* Effect.raceFirst(
      options.hooks.turnStopping(context, { reason: "completed", stepCount: step }),
      options.interrupt.await.pipe(Effect.map(() => null)),
    )

    if (continuation === null) {
      yield* options.append({ _tag: "turn/end", reason: "interrupted" })
      closed = true
      return {
        _tag: "Interrupted" as const,
        stepCount: step,
        totalSteps: currentTotalSteps,
      }
    }

    yield* options.append({ _tag: "turn/end", reason: "completed" })
    closed = true

    if (continuation !== undefined) {
      return {
        _tag: "Continue" as const,
        prompt: continuation.prompt,
        stepCount: step,
        totalSteps: currentTotalSteps,
      }
    }

    return {
      _tag: "Stop" as const,
      reason: "completed" as const,
      stepCount: step,
      totalSteps: currentTotalSteps,
    }
  })

  return execution.pipe(
    Effect.tapCause((cause) => {
      if (!started || closed) return Effect.void
      const interrupted = Cause.hasInterruptsOnly(cause)
      return Effect.uninterruptible(
        options.append(
          interrupted
            ? { _tag: "turn/end", reason: "interrupted" }
            : { _tag: "turn/end", reason: "failed", message: Cause.pretty(cause).trim() },
        ),
      )
    }),
  )
}
