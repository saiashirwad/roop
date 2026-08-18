import { Cause, Effect, Option, Stream } from "effect"
import {
  type AiError,
  type Chat,
  LanguageModel,
  Prompt,
  type Toolkit,
  type Response,
} from "effect/unstable/ai"
import type * as Tool from "effect/unstable/ai/Tool"

import { AgentEmit, type AgentEvent, type SessionEvent } from "./AgentEvents.ts"
import type { StepRejected, AgentHooksInterface, RunContext } from "./AgentHooks.ts"
import type { SessionId } from "./DomainIds.ts"
import { runError, type RunError } from "./RunError.ts"
import type { ResolvedRunPolicy } from "./RunPolicy.ts"
import type { InterruptSignal } from "./RunRegistry.ts"
import { makeToolCallCorrelator } from "./toolCallCorrelator.ts"
import type { ToolScheduler } from "./toolScheduler.ts"

export type ErasedToolkit = Toolkit.WithHandler<Record<string, Tool.Any>>
export type ToolCallParameters = Tool.Parameters<Tool.Any>

/**
 * Erase a toolkit's name-to-parameter relationship after its handlers have
 * been built. Toolkit itself still validates every call before dispatching it.
 */
export const eraseToolkit = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.WithHandler<Tools>,
): ErasedToolkit => {
  /* SAFETY: Tool names originate from `toolkit.tools`; Toolkit validates the
   * corresponding parameters before invoking the handler. */
  return { tools: toolkit.tools, handle: toolkit.handle } as ErasedToolkit
}

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
  | {
      readonly _tag: "Steered"
      readonly steerPrompt: string
      readonly partialParts: ReadonlyArray<Response.StreamPart<Record<string, Tool.Any>>>
    }

export interface RunStepOptions {
  readonly sessionId: SessionId | string
  readonly turn: number
  readonly step: number
  /** Monotonic session step index journaled on `step/start`. Defaults to `step`. */
  readonly stepIndex?: number | undefined
  readonly chat: Chat.Service
  readonly model: LanguageModel.Service
  /** A request-bound capability snapshot. */
  readonly toolkit: Effect.Effect<ErasedToolkit>
  readonly beforeRequest?: (() => Effect.Effect<void, RunError>) | undefined
  readonly interrupt: InterruptSignal
  readonly append: (event: SessionEvent) => Effect.Effect<void, RunError>
  readonly emit: (event: AgentEvent) => Effect.Effect<void>
  readonly hooks: AgentHooksInterface
  readonly scheduler: ToolScheduler
  readonly policy?: Pick<ResolvedRunPolicy, "modelTimeout" | "toolTimeout" | "maxToolOutputBytes">
}

const toEvent = (
  part: Response.StreamPart<Record<string, Tool.Any>>,
  onToolCall?: (
    name: string,
    params: ToolCallParameters,
    id: string,
    providerExecuted: boolean,
  ) => string | undefined,
  onToolResult?: (id: string) => string | undefined,
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
      const localId = onToolCall?.(
        part.name,
        part.params as ToolCallParameters,
        part.id,
        part.providerExecuted,
      )
      return {
        _tag: "ToolCall",
        id: localId ?? part.id,
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
        id: onToolResult?.(part.id) ?? part.id,
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
  append: (event: SessionEvent) => Effect.Effect<void, RunError>,
  outcome: ReadonlyArray<Response.StreamPart<Record<string, Tool.Any>>>,
): Effect.Effect<void, RunError> => {
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
  append: (event: SessionEvent) => Effect.Effect<void, RunError>,
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
          yield* Effect.orDie(append({ _tag: "model/request", request: admitted }))
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

/* oxlint-disable-next-line anti-slop/no-unknown-parameters -- encoded tool results are schema-erased at this boundary. */
const encodedBytes = (value: unknown): number => {
  const json = JSON.stringify(value)
  return json === undefined ? 0 : new TextEncoder().encode(json).byteLength
}

const outputTooLarge = (maxBytes: number) => ({
  type: "tool-output-too-large" as const,
  message: `tool output exceeded ${maxBytes} bytes`,
})

/** `beforeToolExecute`/`afterToolExecute` seams: `WithHandler.handle` is the single choke point. */
const interceptToolkit = (
  toolkit: ErasedToolkit,
  hooks: AgentHooksInterface,
  context: () => RunContext,
  emit: (event: AgentEvent) => Effect.Effect<void>,
  scheduler: ToolScheduler,
  correlator: ReturnType<typeof makeToolCallCorrelator>,
  policy: Pick<ResolvedRunPolicy, "toolTimeout" | "maxToolOutputBytes">,
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
          Effect.suspend(() =>
            /* oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- Tool.Any's existential requirements channel is preserved through the generic execution hook. */
            hooks.withToolExecution(
              context(),
              { name, params: admitted.params },
              toolkit.handle(name, admitted.params).pipe(
                Effect.provideService(AgentEmit, {
                  emit: (event) => {
                    if (event._tag === "Subagent") {
                      return emit({ ...event, toolCallId: token })
                    }
                    return emit(event)
                  },
                  toolCallId: token,
                }),
              ),
            ),
          ),
        )
        const timed =
          policy.toolTimeout === undefined
            ? scheduled
            : Stream.unwrap(
                /* oxlint-disable-next-line effecttsgo/any-unknown-in-error-context -- Tool.Any's existential requirements channel leaks through ErasedToolkit.handle; handlers are built closed before eraseToolkit and closure is reasserted at asClosedToolkit. */
                Effect.timeout(Stream.runCollect(scheduled), policy.toolTimeout).pipe(
                  Effect.map((results) => Stream.fromIterable([...results])),
                ),
              )
        const bounded =
          policy.maxToolOutputBytes === undefined
            ? timed
            : Stream.map(timed, (result) => {
                if (
                  result.preliminary ||
                  encodedBytes(result.encodedResult) <= policy.maxToolOutputBytes!
                )
                  return result
                const failure = outputTooLarge(policy.maxToolOutputBytes!)
                return { ...result, result: failure, encodedResult: failure, isFailure: true }
              })
        return Stream.tap(bounded, (result) =>
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

/** Synthesizes standard end markers for any unclosed streaming text or reasoning tokens. */
const closeOpenParts = (parts: Array<Response.StreamPart<Record<string, Tool.Any>>>): void => {
  const openText = new Set<string>()
  const openReasoning = new Set<string>()
  for (const part of parts) {
    if (part.type === "text-start") {
      openText.add(part.id)
    } else if (part.type === "text-end") {
      openText.delete(part.id)
    } else if (part.type === "reasoning-start") {
      openReasoning.add(part.id)
    } else if (part.type === "reasoning-end") {
      openReasoning.delete(part.id)
    }
  }
  for (const id of openText) {
    /* SAFETY: Synthesizing standard text-end marker for unclosed streaming text ID. */
    parts.push({ type: "text-end", id } as Response.StreamPart<Record<string, Tool.Any>>)
  }
  for (const id of openReasoning) {
    /* SAFETY: Synthesizing standard reasoning-end marker for unclosed streaming reasoning ID. */
    parts.push({ type: "reasoning-end", id } as Response.StreamPart<Record<string, Tool.Any>>)
  }
}

/**
 * Executes a single step: one model request and its corresponding tool calls.
 */
export const runStep = (
  options: RunStepOptions,
): Effect.Effect<StepOutcome, AiError.AiError | StepRejected | RunError> => {
  const context: RunContext = {
    sessionId: options.sessionId,
    turn: options.turn,
    step: options.step,
  }

  let started = false
  let closed = false
  const policy = options.policy ?? {}

  const execution = Effect.gen(function* () {
    yield* options.append({ _tag: "step/start", index: options.stepIndex ?? options.step })
    started = true

    const pendingSteer = yield* options.interrupt.pollSteer
    if (Option.isSome(pendingSteer)) {
      yield* options.append({ _tag: "step/end", reason: "interrupted" })
      closed = true
      return {
        _tag: "Steered" as const,
        steerPrompt: pendingSteer.value,
        partialParts: [],
      }
    }

    const preStep = yield* Effect.raceFirst(
      options.hooks.preStep(context).pipe(Effect.as({ _tag: "Ok" as const })),
      options.interrupt.awaitSignal,
    )
    if (preStep._tag === "Interrupted") {
      yield* options.append({ _tag: "step/end", reason: "interrupted" })
      closed = true
      return { _tag: "Interrupted" as const }
    }
    if (preStep._tag === "Steered") {
      yield* options.append({ _tag: "step/end", reason: "interrupted" })
      closed = true
      return {
        _tag: "Steered" as const,
        steerPrompt: preStep.steerPrompt,
        partialParts: [],
      }
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
    const collectedParts: Array<Response.StreamPart<Record<string, Tool.Any>>> = []

    const modelStream = options.chat
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
            policy,
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
          collectedParts.push(part)

          const event = toEvent(
            part,
            (name, _params, id, providerExecuted) =>
              correlator.observeProviderCall({
                id,
                name,
                providerExecuted,
                isKnownTool: toolkit.tools[name] !== undefined,
              }),
            correlator.tokenForProviderId,
          )
          return event === undefined ? Effect.void : options.emit(event)
        }),
      )
    const collectStream = modelStream.pipe(
      Stream.runCollect,
      Effect.map((parts) => [...parts]),
    )
    const timedStepStream = (
      policy.modelTimeout === undefined
        ? collectStream
        : collectStream.pipe(Effect.timeout(policy.modelTimeout))
    ).pipe(Effect.mapError((cause) => runError(cause, { sessionId: options.sessionId })))

    const outcome = yield* Effect.raceFirst(
      timedStepStream.pipe(Effect.map((parts) => ({ _tag: "Done" as const, parts }))),
      options.interrupt.awaitSignal,
    )

    if (outcome._tag === "Interrupted") {
      yield* options.append({ _tag: "step/end", reason: "interrupted" })
      closed = true
      return { _tag: "Interrupted" as const }
    }

    if (outcome._tag === "Steered") {
      closeOpenParts(collectedParts)
      yield* appendStepEvents(options.append, collectedParts)
      yield* options.append({ _tag: "step/end", reason: "interrupted" })
      closed = true
      return {
        _tag: "Steered" as const,
        steerPrompt: outcome.steerPrompt,
        partialParts: collectedParts,
      }
    }

    yield* appendStepEvents(options.append, outcome.parts)
    yield* options.append({ _tag: "step/end", reason: "completed" })
    closed = true

    const toolCalls = outcome.parts.filter((part) => part.type === "tool-call")
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
