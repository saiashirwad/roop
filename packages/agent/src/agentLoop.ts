import { Cause, Deferred, Effect, Queue, Ref, Stream } from "effect"
import { Chat, LanguageModel, Prompt, Toolkit, type Response } from "effect/unstable/ai"
import type * as Tool from "effect/unstable/ai/Tool"

import { AgentEmit } from "./AgentEmit.ts"
import type { AgentEvent } from "./AgentEvent.ts"
import type { AgentHooksInterface, RunContext } from "./AgentHooks.ts"
import { resolveRunPolicy, type RunPolicy } from "./RunPolicy.ts"
import type { SessionEvent } from "./SessionEvent.ts"
import type { SessionId } from "./SessionId.ts"

export type ErasedToolkit = Toolkit.WithHandler<Record<string, Tool.Any>>
type ToolCallParameters = Tool.Parameters<Tool.Any>

/** Toolkit shape used only to keep `Tool.Any` handler services off Effect channels. */
type ClosedToolkit = Toolkit.WithHandler<Record<string, never>>

interface ClosedToolkitValue {}

const asClosedToolkit = (toolkit: ClosedToolkitValue): ClosedToolkit => {
  /* SAFETY: Tool handlers are already installed; this closes their `any` service channel. */
  return toolkit as ClosedToolkit
}

type LoopOptions = {
  readonly sessionId: SessionId | string
  readonly chat: Chat.Service
  readonly model: LanguageModel.Service
  /** A request-bound capability snapshot. */
  readonly toolkit: Effect.Effect<ErasedToolkit>
  readonly beforeRequest?: (() => Effect.Effect<void>) | undefined
  readonly policy?: RunPolicy | undefined
  readonly interrupt: Deferred.Deferred<void>
  readonly append: (event: SessionEvent) => Effect.Effect<void>
  readonly hooks: AgentHooksInterface
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
  options: LoopOptions,
  outcome: ReadonlyArray<Response.StreamPart<Record<string, Tool.Any>>>,
): Effect.Effect<void> => {
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
  return Effect.forEach(events, options.append, { discard: true })
}

/** `beforeRequest` rewrites only model-facing prompt options. */
const interceptModel = (
  model: LanguageModel.Service,
  hooks: AgentHooksInterface,
  context: () => RunContext,
  append: (event: SessionEvent) => Effect.Effect<void>,
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
  nextToolCallToken: (name: string, params: ToolCallParameters) => string,
  bufferSubagent: (token: string, event: Extract<AgentEvent, { _tag: "Subagent" }>) => void,
): ErasedToolkit => {
  /* SAFETY: The intercept preserves ErasedToolkit.handle while inserting hook seams. */
  return {
    tools: toolkit.tools,
    handle: ((name: string, params: ToolCallParameters) =>
      Effect.gen(function* () {
        // Allocate the token before hooks run. LanguageModel starts concurrent
        // handlers in provider-part order, but hook effects may complete out of
        // order; the token must represent invocation order, not hook timing.
        const token = nextToolCallToken(name, params)
        const admitted = yield* hooks.beforeToolExecute(context(), { name, params })
        const results = yield* toolkit.handle(name, admitted.params).pipe(
          Effect.provideService(AgentEmit, {
            emit: (event) => {
              if (event._tag === "Subagent") {
                bufferSubagent(token, event)
                return Effect.void
              }
              return emit(event)
            },
            toolCallId: token,
          }),
        )
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
  }
}

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
      const policy = resolveRunPolicy(options.policy)
      let turn = 0
      let totalSteps = 0
      let toolCallSequence = 0

      // A turn is one drain of admitted input; a step is one model request
      // plus its tool calls. A `turnStopping` continuation starts a new turn.
      while (true) {
        if (turn >= policy.maxTurns) {
          break
        }
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
          if (totalSteps >= policy.maxTotalSteps || step >= policy.maxStepsPerTurn) {
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

          const toolCallBindings: Array<{ readonly token: string; id?: string | undefined }> = []
          const providerToolCallIds: Array<string> = []
          const bufferedSubagents: Array<{
            readonly token: string
            readonly event: Extract<AgentEvent, { _tag: "Subagent" }>
          }> = []
          const toolkit = yield* options.toolkit
          const stepStream = options.chat
            .streamText({
              prompt: [],
              toolkit: asClosedToolkit(
                interceptToolkit(
                  toolkit,
                  hooks,
                  () => context,
                  emit,
                  (name, _params) => {
                    const token = `${options.sessionId}:${turn}:${step}:${name}:${++toolCallSequence}`
                    toolCallBindings.push({ token, id: providerToolCallIds.shift() })
                    return token
                  },
                  (token, event) => bufferedSubagents.push({ token, event }),
                ),
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
                const event = toEvent(part, (name, _params, id, providerExecuted) => {
                  // LanguageModel skips toolkit.handle for provider-executed
                  // calls and unknown tools; neither gets an invocation token.
                  if (providerExecuted || toolkit.tools[name] === undefined) return
                  const binding = toolCallBindings.find((candidate) => candidate.id === undefined)
                  if (binding !== undefined) {
                    binding.id = id
                  } else {
                    providerToolCallIds.push(id)
                  }
                })
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

          for (const buffered of bufferedSubagents) {
            const actualId = toolCallBindings.find(
              (binding) => binding.token === buffered.token,
            )?.id
            const { toolCallId: _token, ...event } = buffered.event
            yield* emit(actualId === undefined ? event : { ...event, toolCallId: actualId })
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
