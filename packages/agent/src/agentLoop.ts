import { Cause, Deferred, Effect, Queue, Stream } from "effect"
import { Chat, LanguageModel, type Response } from "effect/unstable/ai"
import type * as Tool from "effect/unstable/ai/Tool"

import type { AgentEvent } from "./AgentEvent.ts"
import type { StreamToolkit } from "./Agent.ts"

export type LoopOptions = {
  readonly chat: Chat.Service
  readonly model: LanguageModel.Service
  readonly toolkit: StreamToolkit
  readonly prompt: string
  readonly interrupt: Deferred.Deferred<void>
  readonly onTurn: () => Effect.Effect<void>
}

const toEvent = (part: Response.StreamPart<Record<string, Tool.Any>>): AgentEvent | undefined => {
  switch (part.type) {
    case "text-delta": {
      return { _tag: "TextDelta", delta: part.delta }
    }
    case "reasoning-delta": {
      return { _tag: "ReasoningDelta", delta: part.delta }
    }
    case "tool-call": {
      return { _tag: "ToolCall", id: part.id, name: part.name, params: part.params }
    }
    case "tool-result": {
      if (part.preliminary === true) return undefined
      return {
        _tag: "ToolResult",
        id: part.id,
        name: part.name,
        isFailure: part.isFailure,
        result: part.encodedResult,
      }
    }
    default: {
      return undefined
    }
  }
}

export const runLoop = (options: LoopOptions): Stream.Stream<AgentEvent> =>
  Stream.callback<AgentEvent>((queue) =>
    Effect.gen(function* () {
      const emit = (event: AgentEvent) => Queue.offer(queue, event)
      let firstTurn = true

      while (true) {
        if (yield* Deferred.isDone(options.interrupt)) {
          yield* emit({ _tag: "Finish", reason: "interrupted" })
          return
        }

        const turn = options.chat
          .streamText({
            prompt: firstTurn ? options.prompt : [],
            toolkit: options.toolkit,
            concurrency: "unbounded",
          })
          .pipe(
            Stream.provideService(LanguageModel.LanguageModel, options.model),
            Stream.tap((part) => {
              const event = toEvent(part)
              return event === undefined ? Effect.void : emit(event)
            }),
            Stream.runCollect,
            Effect.map((parts) => [...parts]),
          )

        const outcome = yield* Effect.raceFirst(
          turn,
          Deferred.await(options.interrupt).pipe(Effect.map(() => null)),
        )

        if (outcome === null) {
          yield* emit({ _tag: "Finish", reason: "interrupted" })
          return
        }

        firstTurn = false
        yield* options.onTurn()

        if (!outcome.some((part) => part.type === "tool-call")) {
          yield* emit({ _tag: "Finish", reason: "completed" })
          return
        }
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Queue.offer(queue, {
            _tag: "Finish",
            reason: "failed",
            message: Cause.pretty(cause).trim(),
          }),
      ),
      Effect.ensuring(Queue.end(queue)),
      Effect.asVoid,
    ),
  )
