import { Cause, Deferred, Effect, Queue, Ref, Stream } from "effect"
import { Chat, LanguageModel, Prompt, Toolkit, type Response } from "effect/unstable/ai"
import type * as Tool from "effect/unstable/ai/Tool"

import { AgentEmit } from "./AgentEmit.ts"
import type { AgentEvent } from "./AgentEvent.ts"
import type { AgentHooksInterface, RunContext } from "./AgentHooks.ts"
import type { SessionEvent } from "./SessionEvent.ts"

export type ErasedToolkit = Toolkit.WithHandler<Record<string, Tool.Any>>

/** Toolkit shape used only to keep `Tool.Any` handler services off Effect channels. */
type ClosedToolkit = Toolkit.WithHandler<Record<string, never>>

interface ClosedToolkitValue {}

const asClosedToolkit = (toolkit: ClosedToolkitValue): ClosedToolkit => {
  /* SAFETY: Tool handlers are already installed; this closes their `any` service channel. */
  return toolkit as ClosedToolkit
}

type LoopOptions = {
  readonly sessionId: string
  readonly chat: Chat.Service
  readonly model: LanguageModel.Service
  /** A request-bound capability snapshot. */
  readonly toolkit: Effect.Effect<ErasedToolkit>
  readonly beforeRequest?: (() => Effect.Effect<void>) | undefined
  readonly maxTurns?: number | undefined
  readonly interrupt: Deferred.Deferred<void>
  readonly append: (event: SessionEvent) => Effect.Effect<void>
  readonly hooks: AgentHooksInterface
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

/** Journal the exact assistant/tool messages produced by this model response. */
const appendStepEvents = (
  options: LoopOptions,
  outcome: ReadonlyArray<Response.StreamPart<Record<string, Tool.Any>>>,
): Effect.Effect<void> => {
  const content = Prompt.fromResponseParts(outcome).content
  const events: Array<SessionEvent> = []
  for (const message of content) {
    if (message.role === "assistant") {
      const parts = message.content
        .filter((part) => part.type === "text" || part.type === "reasoning")
        .map((part) => ({ type: part.type, text: part.text }))
      if (parts.length > 0) events.push({ _tag: "assistant/message", parts })
      for (const part of message.content) {
        if (part.type === "tool-call")
          events.push({ _tag: "tool/call", id: part.id, name: part.name, params: part.params })
      }
    } else if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type === "tool-result")
          events.push({
            _tag: "tool/result",
            id: part.id,
            name: part.name,
            isFailure: part.isFailure,
            result: part.result,
          })
      }
    }
  }
  return Effect.forEach(events, options.append, { discard: true })
}

/** `beforeRequest` rewrites only model-facing prompt options. */
const interceptModel = (
  model: LanguageModel.Service,
  hooks: AgentHooksInterface,
  context: () => RunContext,
  append: (event: SessionEvent) => Effect.Effect<void>,
): LanguageModel.Service => ({
  ...model,
  /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
  streamText: ((request: LanguageModel.GenerateTextOptions<Record<string, Tool.Any>>) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const admitted = yield* hooks.beforeRequest(context(), {
          prompt: request.prompt,
          toolChoice: request.toolChoice,
        })
        yield* append({ _tag: "model/request", request: admitted })
        /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
        return model.streamText({
          prompt: admitted.prompt,
          toolChoice: admitted.toolChoice,
          // Tool execution and concurrency are loop-owned; hook output cannot
          // disable or replace either control.
          toolkit: request.toolkit,
          concurrency: request.concurrency,
        } as never)
      }),
    )) as LanguageModel.Service["streamText"],
})

/**
 * The denial envelope effect/unstable/ai itself uses for refused tool calls;
 * the model sees a failed result and the run continues.
 */
const executionDenied = (reason: string) => {
  const denied = { type: "execution-denied" as const, reason }
  return { result: denied, encodedResult: denied, isFailure: true, preliminary: false }
}

/** `beforeToolExecute`/`afterToolExecute` seams: `WithHandler.handle` is the single choke point. */
const interceptToolkit = (
  toolkit: ErasedToolkit,
  hooks: AgentHooksInterface,
  context: () => RunContext,
): ErasedToolkit => ({
  tools: toolkit.tools,
  /* SAFETY: The intercept preserves ErasedToolkit.handle while inserting hook seams. */
  handle: ((name: string, params: Tool.Parameters<Tool.Any>) =>
    Effect.gen(function* () {
      const admitted = yield* hooks.beforeToolExecute(context(), { name, params })
      const results = yield* toolkit.handle(name, admitted.params)
      return Stream.tap(results, (result) =>
        result.preliminary === true
          ? Effect.void
          : hooks.afterToolExecute(
              context(),
              { name, params: admitted.params },
              result.isFailure === true,
            ),
      )
    }).pipe(
      Effect.catchTag("ToolRejected", (rejection) =>
        Effect.succeed(
          Stream.make(executionDenied(rejection.reason)).pipe(
            Stream.tap(() => hooks.afterToolExecute(context(), { name, params }, true)),
          ),
        ),
      ),
    )) as ErasedToolkit["handle"],
})

export const runLoop = (options: LoopOptions): Stream.Stream<AgentEvent> =>
  Stream.callback<AgentEvent>((queue) => {
    // The failure path below runs outside the loop body, so step/turn openness
    // lives here rather than per-iteration.
    let turnOpen = false
    let openStep = false

    const body = Effect.gen(function* () {
      const emit = (event: AgentEvent) => Queue.offer(queue, event)
      const append = options.append
      const hooks = options.hooks
      let turn = 0
      let totalSteps = 0

      // A turn is one drain of admitted input; a step is one model request
      // plus its tool calls. A `turnStopping` continuation starts a new turn.
      while (true) {
        turn += 1
        let step = 0
        let context: RunContext = { sessionId: options.sessionId, turn, step: 0 }
        yield* append({ _tag: "turn/start" })
        turnOpen = true

        let stop: "completed" | "stopped" | "interrupted"
        while (true) {
          if (yield* Deferred.isDone(options.interrupt)) {
            stop = "interrupted"
            break
          }
          if (options.maxTurns !== undefined && totalSteps >= options.maxTurns) {
            stop = "stopped"
            break
          }

          step += 1
          totalSteps += 1
          context = { ...context, step }
          yield* append({ _tag: "step/start", index: step })
          openStep = true
          const preStep = yield* Effect.raceFirst(
            hooks.preStep(context),
            Deferred.await(options.interrupt).pipe(Effect.map(() => null)),
          )
          if (preStep === null) {
            yield* append({ _tag: "step/end", reason: "interrupted" })
            openStep = false
            stop = "interrupted"
            break
          }

          if (options.beforeRequest !== undefined) {
            yield* options.beforeRequest()
          }

          const stepStream = options.chat
            .streamText({
              prompt: [],
              toolkit: asClosedToolkit(
                interceptToolkit(yield* options.toolkit, hooks, () => context),
              ),
              concurrency: "unbounded",
            })
            .pipe(
              Stream.provideService(
                LanguageModel.LanguageModel,
                interceptModel(options.model, hooks, () => context, append),
              ),
              Stream.provideService(AgentEmit, { emit }),
              Stream.tap((part) => {
                const event = toEvent(part)
                return event === undefined ? Effect.void : emit(event)
              }),
              Stream.runCollect,
              Effect.map((parts) => [...parts]),
            )

          const outcome = yield* Effect.raceFirst(
            stepStream,
            Deferred.await(options.interrupt).pipe(Effect.map(() => null)),
          )

          if (outcome === null) {
            yield* append({ _tag: "step/end", reason: "interrupted" })
            openStep = false
            stop = "interrupted"
            break
          }

          yield* appendStepEvents(options, outcome)
          yield* append({ _tag: "step/end", reason: "completed" })
          openStep = false

          if (!outcome.some((part) => part.type === "tool-call")) {
            stop = "completed"
            break
          }
        }

        const continuation =
          stop === "completed"
            ? yield* Effect.raceFirst(
                hooks.turnStopping(context, { reason: stop, stepCount: step }),
                Deferred.await(options.interrupt).pipe(Effect.map(() => null)),
              )
            : undefined
        if (continuation === null) stop = "interrupted"
        yield* append({ _tag: "turn/end", reason: stop })
        turnOpen = false
        if (continuation === undefined || continuation === null || stop !== "completed") {
          yield* emit({ _tag: "Finish", reason: stop })
          return
        }
        yield* append({ _tag: "user/message", content: continuation.prompt })
        yield* Ref.update(options.chat.history, (history) =>
          Prompt.concat(history, Prompt.make(continuation.prompt)),
        )
      }
    })

    return body.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.gen(function* () {
              const message = Cause.pretty(cause).trim()
              if (openStep) {
                yield* options.append({ _tag: "step/end", reason: "failed", message })
              }
              if (turnOpen) {
                yield* options.append({ _tag: "turn/end", reason: "failed", message })
              }
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
