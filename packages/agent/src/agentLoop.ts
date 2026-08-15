import { Cause, Deferred, Effect, Queue, Ref, Stream } from "effect"
import { Chat, LanguageModel, Toolkit, type Response } from "effect/unstable/ai"
import type * as Tool from "effect/unstable/ai/Tool"

import { AgentEmit } from "./AgentEmit.ts"
import type { AgentEvent } from "./AgentEvent.ts"
import type { SessionEvent } from "./SessionEvent.ts"

export type ErasedToolkit = Toolkit.WithHandler<Record<string, Tool.Any>>

export type LoopOptions = {
  readonly chat: Chat.Service
  readonly model: LanguageModel.Service
  readonly toolkit: ErasedToolkit
  readonly maxTurns?: number | undefined
  readonly interrupt: Deferred.Deferred<void>
  readonly append: (event: SessionEvent) => Effect.Effect<void>
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

/**
 * Append the durable events for one completed turn, derived from the history
 * the model actually consumed — the projection of these events is by
 * construction identical to `chat.history`'s per-turn delta.
 */
const appendTurnEvents = (options: LoopOptions, historyBefore: number): Effect.Effect<void> =>
  Effect.gen(function* () {
    const history = yield* Ref.get(options.chat.history)
    const appended: Array<SessionEvent> = []
    for (const message of history.content.slice(historyBefore)) {
      if (message.role === "assistant") {
        const parts = message.content
          .filter((part) => part.type === "text" || part.type === "reasoning")
          .map((part) => ({ type: part.type, text: part.text }))
        if (parts.length > 0) appended.push({ _tag: "assistant/message", parts })
        for (const part of message.content) {
          if (part.type !== "tool-call") continue
          appended.push({
            _tag: "tool/call",
            id: part.id,
            name: part.name,
            params: part.params,
          })
        }
      } else if (message.role === "tool") {
        for (const part of message.content) {
          if (part.type !== "tool-result") continue
          appended.push({
            _tag: "tool/result",
            id: part.id,
            name: part.name,
            isFailure: part.isFailure,
            result: part.result,
          })
        }
      }
    }
    yield* Effect.forEach(appended, options.append, { discard: true })
  })

export const runLoop = (options: LoopOptions): Stream.Stream<AgentEvent> =>
  Stream.callback<AgentEvent>((queue) => {
    let openTurn = false

    const body = Effect.gen(function* () {
      const emit = (event: AgentEvent) => Queue.offer(queue, event)
      const append = options.append
      let turns = 0
      const endTurn = (event: SessionEvent) =>
        Effect.suspend(() => {
          if (!openTurn) return Effect.void
          openTurn = false
          return append(event)
        })

      while (true) {
        if (yield* Deferred.isDone(options.interrupt)) {
          yield* emit({ _tag: "Finish", reason: "interrupted" })
          return
        }

        if (options.maxTurns !== undefined && turns >= options.maxTurns) {
          yield* emit({ _tag: "Finish", reason: "stopped" })
          return
        }

        const historyBefore = (yield* Ref.get(options.chat.history)).content.length
        openTurn = true
        yield* append({ _tag: "turn/start" })

        const turn = options.chat
          .streamText({
            prompt: [],
            toolkit: options.toolkit,
            concurrency: "unbounded",
          })
          .pipe(
            Stream.provideService(LanguageModel.LanguageModel, options.model),
            Stream.provideService(AgentEmit, { emit }),
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
          yield* endTurn({ _tag: "turn/end", reason: "interrupted" })
          yield* emit({ _tag: "Finish", reason: "interrupted" })
          return
        }

        turns += 1
        yield* appendTurnEvents(options, historyBefore)
        yield* endTurn({ _tag: "turn/end", reason: "completed" })

        if (!outcome.some((part) => part.type === "tool-call")) {
          yield* emit({ _tag: "Finish", reason: "completed" })
          return
        }
      }
    })

    return body.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.gen(function* () {
              if (openTurn) {
                yield* options.append({
                  _tag: "turn/end",
                  reason: "failed",
                  message: Cause.pretty(cause).trim(),
                })
              }
              yield* Queue.offer(queue, {
                _tag: "Finish",
                reason: "failed",
                message: Cause.pretty(cause).trim(),
              })
            }),
      ),
      Effect.ensuring(Queue.end(queue)),
      Effect.asVoid,
    )
  })
