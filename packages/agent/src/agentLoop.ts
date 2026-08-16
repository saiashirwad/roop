import { Cause, Effect, Queue, Ref, Stream } from "effect"
import { Prompt, type Chat, type LanguageModel } from "effect/unstable/ai"

import type { AgentEvent } from "./AgentEvent.ts"
import type { AgentHooksInterface } from "./AgentHooks.ts"
import { resolveRunPolicy, type RunPolicy } from "./RunPolicy.ts"
import type { InterruptSignal } from "./RunRegistry.ts"
import { runStep, type ErasedToolkit } from "./runStep.ts"
import { runTurn } from "./runTurn.ts"
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
  readonly beforeRequest?: (() => Effect.Effect<void>) | undefined
  readonly policy?: RunPolicy | undefined
  readonly interrupt: InterruptSignal
  readonly append: (event: SessionEvent) => Effect.Effect<void>
  readonly hooks: AgentHooksInterface
}

/**
 * Orchestrates agent turns and steps, emitting live stream events and
 * ensuring a single terminal Finish event on completion.
 */
export const runLoop = (options: LoopOptions): Stream.Stream<AgentEvent> =>
  Stream.callback<AgentEvent>((queue) => {
    const body = Effect.gen(function* () {
      const emit = (event: AgentEvent) => Queue.offer(queue, event)
      const policy = resolveRunPolicy(options.policy)
      const scheduler = yield* makeToolScheduler(policy.toolConcurrency)

      let turn = 0
      let totalSteps = 0

      // A turn is one drain of admitted input; a step is one model request
      // plus its tool calls. A `turnStopping` continuation starts a new turn.
      while (true) {
        if (turn >= policy.maxTurns) {
          yield* emit({ _tag: "Finish", reason: "stopped" })
          return
        }

        turn += 1

        const turnOutcome = yield* runTurn({
          sessionId: options.sessionId,
          turn,
          totalSteps,
          policy,
          interrupt: options.interrupt,
          append: options.append,
          hooks: options.hooks,
          runStep: ({ turn: currentTurn, step: currentStep }) =>
            runStep({
              sessionId: options.sessionId,
              turn: currentTurn,
              step: currentStep,
              chat: options.chat,
              model: options.model,
              toolkit: options.toolkit,
              beforeRequest: options.beforeRequest,
              interrupt: options.interrupt,
              append: options.append,
              emit,
              hooks: options.hooks,
              scheduler,
            }),
        })

        totalSteps = turnOutcome.totalSteps

        switch (turnOutcome._tag) {
          case "Stop": {
            yield* emit({ _tag: "Finish", reason: turnOutcome.reason })
            return
          }
          case "Interrupted": {
            yield* emit({ _tag: "Finish", reason: "interrupted" })
            return
          }
          case "LimitReached": {
            yield* emit({ _tag: "Finish", reason: "stopped" })
            return
          }
          case "Continue": {
            yield* options.append({ _tag: "user/message", content: turnOutcome.prompt })
            yield* Ref.update(options.chat.history, (history) =>
              Prompt.concat(history, Prompt.make(turnOutcome.prompt)),
            )
            break
          }
        }
      }
    })

    return body.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.gen(function* () {
              const message = Cause.pretty(cause).trim()
              yield* Queue.offer(queue, {
                _tag: "Finish",
                reason: "failed",
                message,
              })
            }),
      ),
      Effect.ensuring(Queue.end(queue)),
      Effect.asVoid,
    )
  })
