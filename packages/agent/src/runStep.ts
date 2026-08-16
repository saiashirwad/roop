import { Cause, Effect, Stream } from "effect"
import { AiError, Chat, LanguageModel, Prompt, Toolkit, type Response } from "effect/unstable/ai"
import type * as Tool from "effect/unstable/ai/Tool"

import { AgentEmit } from "./AgentEmit.ts"
import type { AgentEvent } from "./AgentEvent.ts"
import { StepRejected, type AgentHooksInterface, type RunContext } from "./AgentHooks.ts"
import type { InterruptSignal } from "./RunRegistry.ts"
import type { SessionEvent } from "./SessionEvent.ts"
import type { SessionId } from "./SessionId.ts"
import { makeToolCallCorrelator } from "./toolCallCorrelator.ts"
import type { ToolScheduler } from "./toolScheduler.ts"

export type ErasedToolkit = Toolkit.WithHandler<Record<string, Tool.Any>>
export type ToolCallParameters = Tool.Parameters<Tool.Any>

/** Toolkit shape used only to keep `Tool.Any` handler services off Effect channels. */
type ClosedToolkit = Toolkit.WithHandler<Record<string, never>>

interface ClosedToolkitValue {}

const asClosedToolkit = (toolkit: ClosedToolkitValue): ClosedToolkit => {
  /* SAFETY: Tool handlers are already installed; this closes their `any` service channel. */
  return toolkit as ClosedToolkit
}

export type StepOutcome =
  | {
      readonly _tag: "Stop"
      readonly toolCallCount: 0
    }
  | {
      readonly _tag: "ToolCalls"
      readonly toolCallCount: number
    }
  | {
      readonly _tag: "Interrupted"
    }

export interface RunStepOptions {
  readonly sessionId: SessionId | string
  readonly turn: number
  readonly step: number
  readonly chat: Chat.Service
  readonly model: LanguageModel.Service
  /** A request-bound capability snapshot. */
  readonly toolkit: Effect.Effect<ErasedToolkit>
  readonly beforeRequest?: (() => Effect.Effect<void, any>) | undefined
  readonly interrupt: InterruptSignal
  readonly append: (event: SessionEvent) => Effect.Effect<void, any>
  readonly emit: (event: AgentEvent) => Effect.Effect<void>
  readonly hooks: AgentHooksInterface
  readonly scheduler: ToolScheduler
}

const toEvent = (
  part: Response.StreamPart<Record<string, Tool.Any>>,
  onToolCall?: (
    name: string,
    params: ToolCallParameters,
    id: string,
    providerExecuted: boolean,
  ) => void,
): AgentEvent | undefined => {
  switch (part.type) {
    case "text-delta": {
      return { _tag: "TextDelta", delta: part.delta }
    }
    case "reasoning-delta": {
      return { _tag: "ReasoningDelta", delta: part.delta }
    }
    case "tool-call": {
      /* SAFETY: Every tool-call part is decoded against the toolkit's parameter schema. */
      onToolCall?.(part.name, part.params as ToolCallParameters, part.id, part.providerExecuted)
      return {
        _tag: "ToolCall",
        id: part.id,
        name: part.name,
        params: part.params,
        providerExecuted: part.providerExecuted,
      }
    }
    case "tool-result": {
      if (part.preliminary === true) return undefined
      const providerExecuted =
        "providerExecuted" in part && typeof part.providerExecuted === "boolean"
          ? part.providerExecuted
          : undefined
      return {
        _tag: "ToolResult",
        id: part.id,
        name: part.name,
        isFailure: part.isFailure,
        result: part.encodedResult,
        ...(providerExecuted === undefined ? undefined : { providerExecuted }),
      }
    }
    default: {
      return undefined
    }
  }
}

/** Journal the exact assistant/tool messages produced by this model response. */
const appendStepEvents = (
  append: (event: SessionEvent) => Effect.Effect<void, any>,
  outcome: ReadonlyArray<Response.StreamPart<Record<string, Tool.Any>>>,
): Effect.Effect<void, any> => {
  const content = Prompt.fromResponseParts(outcome).content
  const providerExecutedByResultId = new Map(
    outcome.flatMap((part) =>
      part.type === "tool-result" &&
      "providerExecuted" in part &&
      typeof part.providerExecuted === "boolean"
        ? [[part.id, part.providerExecuted] as const]
        : [],
    ),
  )
  const events: Array<SessionEvent> = []
  for (const message of content) {
    if (message.role === "assistant") {
      const parts = message.content
        .filter((part) => part.type === "text" || part.type === "reasoning")
        .map((part) => ({ type: part.type, text: part.text }))
      if (parts.length > 0) events.push({ _tag: "assistant/message", parts })
      for (const part of message.content) {
        if (part.type === "tool-call")
          events.push({
            _tag: "tool/call",
            id: part.id,
            name: part.name,
            params: part.params,
            providerExecuted: part.providerExecuted,
          })
      }
    } else if (message.role === "tool") {
      for (const part of message.content) {
        if (part.type === "tool-result") {
          const providerExecuted = providerExecutedByResultId.get(part.id)
          /* Response's decoded result carries this field; preserve it even
           * though Prompt's model-facing result part does not in beta.97. */
          events.push({
            _tag: "tool/result",
            id: part.id,
            name: part.name,
            isFailure: part.isFailure,
            result: part.result,
            ...(providerExecuted === undefined ? undefined : { providerExecuted }),
          })
        }
      }
    }
  }
  return Effect.forEach(events, append, { discard: true })
}

/** `beforeRequest` rewrites only model-facing prompt options. */
const interceptModel = (
  model: LanguageModel.Service,
  hooks: AgentHooksInterface,
  context: () => RunContext,
  append: (event: SessionEvent) => Effect.Effect<void, any>,
): LanguageModel.Service => {
  /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
  return {
    ...model,
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
  }
}

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
  emit: (event: AgentEvent) => Effect.Effect<void>,
  scheduler: ToolScheduler,
  correlator: ReturnType<typeof makeToolCallCorrelator>,
): ErasedToolkit => {
  /* SAFETY: The intercept preserves ErasedToolkit.handle while inserting hook seams. */
  return {
    tools: toolkit.tools,
    handle: ((name: string, params: ToolCallParameters) =>
      Effect.gen(function* () {
        // Allocate the token before hooks or scheduler wait. LanguageModel starts concurrent
        // handlers in provider-part order, but hook/scheduling timing may vary; the token
        // must represent invocation order, not execution timing.
        const token = correlator.allocateToken(name)
        const admitted = yield* hooks.beforeToolExecute(context(), { name, params })
        const scheduled = scheduler.scheduleEffect(
          toolkit.handle(name, admitted.params).pipe(
            Effect.provideService(AgentEmit, {
              emit: (event) => {
                if (event._tag === "Subagent") {
                  correlator.stageSubagent(token, event)
                  return Effect.void
                }
                return emit(event)
              },
              toolCallId: token,
            }),
          ),
        )
        return Stream.tap(scheduled, (result) =>
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
  }
}

/**
 * Executes a single step: one model request and its corresponding tool calls.
 */
export const runStep = (
  options: RunStepOptions,
): Effect.Effect<StepOutcome, AiError.AiError | StepRejected> => {
  const context: RunContext = {
    sessionId: options.sessionId,
    turn: options.turn,
    step: options.step,
  }

  let started = false
  let closed = false

  const execution = Effect.gen(function* () {
    yield* options.append({ _tag: "step/start", index: options.step })
    started = true

    const preStep = yield* Effect.raceFirst(
      options.hooks.preStep(context),
      options.interrupt.await.pipe(Effect.map(() => null)),
    )
    if (preStep === null) {
      yield* options.append({ _tag: "step/end", reason: "interrupted" })
      closed = true
      return { _tag: "Interrupted" as const }
    }

    if (options.beforeRequest !== undefined) {
      yield* options.beforeRequest()
    }

    const correlator = makeToolCallCorrelator({
      sessionId: options.sessionId.toString(),
      turn: options.turn,
      step: options.step,
    })

    const toolkit = yield* options.toolkit
    const stepStream = options.chat
      .streamText({
        prompt: [],
        toolkit: asClosedToolkit(
          interceptToolkit(
            toolkit,
            options.hooks,
            () => context,
            options.emit,
            options.scheduler,
            correlator,
          ),
        ),
        concurrency: "unbounded",
      })
      .pipe(
        Stream.provideService(
          LanguageModel.LanguageModel,
          interceptModel(options.model, options.hooks, () => context, options.append),
        ),
        Stream.provideService(AgentEmit, { emit: options.emit }),
        Stream.tap((part) => {
          const event = toEvent(part, (name, _params, id, providerExecuted) => {
            correlator.observeProviderCall({
              id,
              name,
              providerExecuted,
              isKnownTool: toolkit.tools[name] !== undefined,
            })
          })
          return event === undefined ? Effect.void : options.emit(event)
        }),
        Stream.runCollect,
        Effect.map((parts) => [...parts]),
      )

    const outcome = yield* Effect.raceFirst(
      stepStream,
      options.interrupt.await.pipe(Effect.map(() => null)),
    )

    if (outcome === null) {
      yield* options.append({ _tag: "step/end", reason: "interrupted" })
      closed = true
      return { _tag: "Interrupted" as const }
    }

    for (const event of correlator.drainSubagentEvents()) {
      yield* options.emit(event)
    }

    yield* appendStepEvents(options.append, outcome)
    yield* options.append({ _tag: "step/end", reason: "completed" })
    closed = true

    const toolCalls = outcome.filter((part) => part.type === "tool-call")
    if (toolCalls.length > 0) {
      return { _tag: "ToolCalls" as const, toolCallCount: toolCalls.length }
    }

    return { _tag: "Stop" as const, toolCallCount: 0 as const }
  })

  return execution.pipe(
    Effect.tapCause((cause) => {
      if (!started || closed) return Effect.void
      const interrupted = Cause.hasInterruptsOnly(cause)
      return Effect.uninterruptible(
        options.append(
          interrupted
            ? { _tag: "step/end", reason: "interrupted" }
            : { _tag: "step/end", reason: "failed", message: Cause.pretty(cause).trim() },
        ),
      )
    }),
  )
}
