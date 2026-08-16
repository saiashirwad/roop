import { Cause, Effect, Exit, Queue, Ref, Stream } from "effect"
import { Prompt, type Chat, type LanguageModel } from "effect/unstable/ai"

import type { AgentEvent } from "./AgentEvent.ts"
import type { AgentHooksInterface } from "./AgentHooks.ts"
import { RunError, runError } from "./RunError.ts"
import { initialRunState, transition } from "./RunMachine.ts"
import { resolveRunPolicy, type RunPolicy } from "./RunPolicy.ts"
import type { InterruptSignal } from "./RunRegistry.ts"
import { runStep, type ErasedToolkit } from "./runStep.ts"
import type { SessionEvent } from "./SessionEvent.ts"
import type { SessionId } from "./SessionId.ts"
import { makeToolScheduler } from "./toolScheduler.ts"

export type { ErasedToolkit } from "./runStep.ts"

export interface LoopOptions {
  readonly sessionId: SessionId | string
  readonly chat: Chat.Service
  readonly model: LanguageModel.Service
  /** A request-bound capability snapshot. */
  readonly toolkit: Effect.Effect<ErasedToolkit>
  readonly beforeRequest?: (() => Effect.Effect<void, RunError>) | undefined
  readonly policy?: RunPolicy | undefined
  readonly interrupt: InterruptSignal
  readonly append: (event: SessionEvent) => Effect.Effect<void, RunError>
  readonly hooks: AgentHooksInterface
}

/**
 * Orchestrates agent turns and steps, emitting live stream events and
 * ensuring a single terminal Finish event on completion.
 */
export const runLoop = (options: LoopOptions): Stream.Stream<AgentEvent, RunError> =>
  Stream.callback<AgentEvent, RunError>((queue) => {
    let turnOpen = false
    const body = Effect.gen(function* () {
      const emit = (event: AgentEvent) => Queue.offer(queue, event)
      const policy = resolveRunPolicy(options.policy)
      const scheduler = yield* makeToolScheduler(policy.toolConcurrency)
      let machine = initialRunState(policy)

      while (true) {
        const startDecision = transition(machine, { _tag: "StartTurn" })
        machine = startDecision.state
        const start = startDecision.commands[0]
        if (start?._tag === "Finish") {
          yield* emit({ _tag: "Finish", reason: start.reason })
          return
        }
        if (start?._tag !== "StartTurn") return
        yield* options.append({ _tag: "turn/start" })
        turnOpen = true

        let stepCommand = startDecision.commands.find((command) => command._tag === "RunStep")
        while (stepCommand?._tag === "RunStep") {
          const outcome = yield* runStep({
            sessionId: options.sessionId,
            turn: stepCommand.turn,
            step: stepCommand.step,
            chat: options.chat,
            model: options.model,
            toolkit: options.toolkit,
            beforeRequest: options.beforeRequest,
            interrupt: options.interrupt,
            append: options.append,
            emit,
            hooks: options.hooks,
            scheduler,
          })
          if (outcome._tag === "Interrupted") {
            const interruption = transition(machine, { _tag: "Interrupted" })
            machine = interruption.state
            yield* options.append({ _tag: "turn/end", reason: "interrupted" })
            turnOpen = false
            const finish = interruption.commands.find((command) => command._tag === "Finish")
            if (finish?._tag === "Finish") yield* emit({ _tag: "Finish", reason: finish.reason })
            return
          }
          const stepDecision = transition(machine, {
            _tag: "StepCompleted",
            toolCalls: outcome.toolCallCount,
          })
          machine = stepDecision.state
          const next = stepDecision.commands[0]
          if (next?._tag === "Finish") {
            yield* options.append({ _tag: "turn/end", reason: "stopped" })
            turnOpen = false
            yield* emit({ _tag: "Finish", reason: next.reason })
            return
          }
          stepCommand = next?._tag === "RunStep" ? next : undefined
          if (stepCommand === undefined && outcome._tag === "Stop") break
        }

        const context = { sessionId: options.sessionId, turn: machine.turn, step: machine.step }
        const continuation = yield* Effect.raceFirst(
          options.hooks.turnStopping(context, { reason: "completed", stepCount: machine.step }),
          options.interrupt.await.pipe(Effect.map(() => null)),
        )
        if (continuation === null) {
          const interruption = transition(machine, { _tag: "Interrupted" })
          machine = interruption.state
          yield* options.append({ _tag: "turn/end", reason: "interrupted" })
          turnOpen = false
          const finish = interruption.commands.find((command) => command._tag === "Finish")
          if (finish?._tag === "Finish") yield* emit({ _tag: "Finish", reason: finish.reason })
          return
        }
        const endDecision = transition(machine, {
          _tag: "TurnCompleted",
          continuation: continuation !== undefined,
        })
        machine = endDecision.state
        yield* options.append({ _tag: "turn/end", reason: "completed" })
        turnOpen = false
        const command = endDecision.commands[0]
        if (command?._tag === "Finish") {
          yield* emit({ _tag: "Finish", reason: command.reason })
          return
        }
        if (continuation === undefined || command?._tag !== "Continue") return
        yield* options.append({ _tag: "user/message", content: continuation.prompt })
        yield* Ref.update(options.chat.history, (history) =>
          Prompt.concat(history, Prompt.make(continuation.prompt)),
        )
      }
    })
    return body.pipe(
      Effect.catchCause((cause) => {
        const interrupted = Cause.hasInterruptsOnly(cause)
        let close: Effect.Effect<void, RunError> = Effect.void
        if (turnOpen) {
          const end = interrupted
            ? ({ _tag: "turn/end", reason: "interrupted" } as const)
            : {
                _tag: "turn/end" as const,
                reason: "failed" as const,
                message: Cause.pretty(cause).trim(),
              }
          close = Effect.uninterruptible(options.append(end)).pipe(Effect.asVoid)
        }
        return Effect.gen(function* () {
          const cleanup = yield* Effect.exit(close)
          if (Exit.isFailure(cleanup)) {
            // Cleanup failures are operational failures too: fail the callback
            // explicitly rather than allowing the finalizer to end it normally.
            yield* Queue.fail(queue, runError(cleanup.cause, { sessionId: options.sessionId }))
            return
          }
          if (!interrupted) {
            yield* Queue.fail(queue, runError(cause, { sessionId: options.sessionId }))
          }
        })
      }),
      Effect.ensuring(Queue.end(queue)),
      Effect.asVoid,
    )
  })
