import { Cause, Effect, Exit, Queue, Ref, Stream } from "effect"
import { Prompt, type Chat, type LanguageModel } from "effect/unstable/ai"

import type { AgentEvent, SessionEvent } from "./AgentEvents.ts"
import type { AgentHooksInterface } from "./AgentHooks.ts"
import type { SessionId } from "./DomainIds.ts"
import { type RunError, runError } from "./RunError.ts"
import { resolveRunPolicy, type RunPolicy } from "./RunPolicy.ts"
import type { InterruptSignal } from "./RunRegistry.ts"
import { runStep, type ErasedToolkit } from "./runStep.ts"
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
    const emit = (event: AgentEvent) => Queue.offer(queue, event)

    const appendUserPrompt = (prompt: string) =>
      Effect.gen(function* () {
        yield* options.append({ _tag: "user/message", content: prompt })
        const promptObj = Prompt.make(prompt)
        yield* Ref.update(options.chat.history, (history) => Prompt.concat(history, promptObj))
      })

    const body = Effect.gen(function* () {
      const policy = resolveRunPolicy(options.policy)
      const scheduler = yield* makeToolScheduler(policy.toolConcurrency)
      let turn = 0
      let totalSteps = 0
      let stepIndex = 0

      while (turn < policy.maxTurns) {
        turn += 1
        let step = 0
        yield* options.append({ _tag: "turn/start" })
        turnOpen = true

        let turnEnded = false

        while (true) {
          step += 1
          stepIndex += 1
          const outcome = yield* runStep({
            sessionId: options.sessionId,
            turn,
            step,
            stepIndex,
            chat: options.chat,
            model: options.model,
            toolkit: options.toolkit,
            beforeRequest: options.beforeRequest,
            interrupt: options.interrupt,
            append: options.append,
            emit,
            hooks: options.hooks,
            scheduler,
            policy,
          })
          if (outcome._tag === "Interrupted") {
            yield* options.append({ _tag: "turn/end", reason: "interrupted" })
            turnOpen = false
            yield* emit({ _tag: "Finish", reason: "interrupted" })
            return
          }
          if (outcome._tag === "Steered") {
            yield* options.append({ _tag: "turn/end", reason: "interrupted" })
            turnOpen = false
            yield* appendUserPrompt(outcome.steerPrompt)
            turnEnded = true
            break
          }

          totalSteps += 1
          const reachedLimit = totalSteps >= policy.maxTotalSteps || step >= policy.maxStepsPerTurn
          if (reachedLimit && outcome._tag === "ToolCalls") {
            yield* options.append({ _tag: "turn/end", reason: "stopped" })
            turnOpen = false
            yield* emit({ _tag: "Finish", reason: "stopped" })
            return
          }
          if (outcome._tag === "Stop" || reachedLimit) break
        }

        if (turnEnded) {
          continue
        }

        const context = { sessionId: options.sessionId, turn, step }
        const turnContinuation = yield* Effect.raceFirst(
          options.hooks
            .turnStopping(context, { reason: "completed", stepCount: step })
            .pipe(Effect.map((continuation) => ({ _tag: "Continue" as const, continuation }))),
          options.interrupt.awaitSignal,
        )

        if (turnContinuation._tag === "Interrupted") {
          yield* options.append({ _tag: "turn/end", reason: "interrupted" })
          turnOpen = false
          yield* emit({ _tag: "Finish", reason: "interrupted" })
          return
        }

        if (turnContinuation._tag === "Steered") {
          yield* options.append({ _tag: "turn/end", reason: "interrupted" })
          turnOpen = false
          yield* appendUserPrompt(turnContinuation.steerPrompt)
          continue
        }

        yield* options.append({ _tag: "turn/end", reason: "completed" })
        turnOpen = false
        if (turnContinuation.continuation === undefined) {
          yield* emit({ _tag: "Finish", reason: "completed" })
          return
        }
        if (turn >= policy.maxTurns || totalSteps >= policy.maxTotalSteps) {
          yield* emit({ _tag: "Finish", reason: "stopped" })
          return
        }
        yield* appendUserPrompt(turnContinuation.continuation.prompt)
      }
      yield* emit({ _tag: "Finish", reason: "stopped" })
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
          // A Prompt consumer drop interrupts this fiber. Publish Finish so
          // session subscribers are not left waiting on takeUntil(Finish).
          if (interrupted) {
            yield* emit({ _tag: "Finish", reason: "interrupted" }).pipe(Effect.ignore)
          } else {
            yield* emit({
              _tag: "Finish",
              reason: "failed",
              message: Cause.pretty(cause).trim(),
            }).pipe(Effect.ignore)
            yield* Queue.fail(queue, runError(cause, { sessionId: options.sessionId }))
          }
        })
      }),
      Effect.ensuring(Queue.end(queue)),
      Effect.asVoid,
    )
  })
