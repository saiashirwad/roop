/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-escape-hatch-assertions, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: these assertions are limited to the compatibility and Effect AI existential boundaries described below. */

import { Cause, Effect, Exit, Option, Queue, Ref, Stream } from "effect"
import {
  type AiError,
  type Chat,
  LanguageModel,
  Prompt,
  type Toolkit,
  type Response,
} from "effect/unstable/ai"
import type * as Tool from "effect/unstable/ai/Tool"

import type { AgentDefinition } from "../Agent.ts"
import type { AgentContext } from "../AgentContext.ts"
import { AgentEmit, type AgentEvent, type SessionEvent } from "../AgentEvents.ts"
import type { StepRejected, AgentHooksInterface, RunContext } from "../AgentHooks.ts"
import { toPrompt as planToPrompt } from "../AgentPlan.ts"
import type { ErasedToolkit } from "../AgentTools.ts"
import type { SessionId } from "../DomainIds.ts"
import type { JournalAppendError } from "../Journal.ts"
import { runError, type RunError } from "../RunError.ts"
import { resolveRunPolicy, type ResolvedRunPolicy, type RunPolicy } from "../RunPolicy.ts"
import type { ControlSignal, InterruptSignal } from "../RunSignal.ts"
import type { InvalidToolName, ToolConflict } from "../ToolRegistry.ts"
import {
  canRetryAttempt,
  defaultModelAttemptPolicy,
  modelAttempt,
  requestFingerprint,
  type AttemptState,
  type LogicalModelRequest,
  type ModelAttemptPolicy,
} from "./effectAiAdapter.ts"
import { makeToolCallCorrelator } from "./toolCallCorrelator.ts"
import { makeToolScheduler, type ToolScheduler } from "./toolScheduler.ts"

export interface RunOptions<R = never, E = never> {
  readonly sessionId: SessionId | string
  readonly chat: Chat.Service
  readonly model: LanguageModel.Service
  /** A request-bound capability snapshot. */
  readonly toolkit: Effect.Effect<ErasedToolkit>
  readonly policy?: RunPolicy | undefined
  readonly interrupt: InterruptSignal
  readonly append: (event: SessionEvent) => Effect.Effect<void, RunError | JournalAppendError>
  readonly hooks: AgentHooksInterface
  /** Explicit agent used by the staged logical-plan interpreter path. */
  readonly agent?: AgentDefinition<R, E> | undefined
  /** Stable run identity supplied to the agent renderer. */
  readonly runId?: string | undefined
  /** Internal logical-attempt seam. Public fallback policy belongs to U6. */
  readonly attemptPolicy?: ModelAttemptPolicy | undefined
}

/** Outcome of one step, as the turn loop sees it. */
type StepOutcome =
  | { readonly _tag: "Stop" }
  | { readonly _tag: "ToolCalls"; readonly toolCallCount: number }
  | ControlSignal

type ToolCallParameters = Tool.Parameters<Tool.Any>

/** Toolkit shape used only to keep `Tool.Any` handler services off Effect channels. */
type ClosedToolkit = Toolkit.WithHandler<Record<string, never>>

interface ClosedToolkitValue {}

const asClosedToolkit = (toolkit: ClosedToolkitValue): ClosedToolkit => {
  /* SAFETY: Tool handlers are already installed; this closes their `any` service channel. */
  return toolkit as ClosedToolkit
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
  append: (event: SessionEvent) => Effect.Effect<void, RunError | JournalAppendError>,
  outcome: ReadonlyArray<Response.StreamPart<Record<string, Tool.Any>>>,
): Effect.Effect<void, RunError | JournalAppendError> => {
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
  append: (event: SessionEvent) => Effect.Effect<void, RunError | JournalAppendError>,
  audit?: {
    readonly planId: string
    readonly fingerprint: string
    readonly toolNames: ReadonlyArray<string>
    readonly attempt?: number | undefined
  },
  recordAudit = true,
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
          if (recordAudit) {
            yield* Effect.orDie(
              append({
                _tag: "model/request",
                request:
                  audit === undefined
                    ? admitted
                    : {
                        ...admitted,
                        planId: audit.planId,
                        fingerprint: audit.fingerprint,
                        toolNames: audit.toolNames,
                        ...(audit.attempt === undefined ? undefined : { attempt: audit.attempt }),
                      },
              }),
            )
          }
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
  onDispatchStart?: (() => void) | undefined,
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
        onDispatchStart?.()
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
 * Executes a run — the turn/step loop over one model, with journal spans,
 * interrupt/steer reaction, tool interception, and the single terminal Finish
 * event — behind one interface.
 */
type RunStreamError<E> =
  | E
  | AiError.AiError
  | RunError
  | JournalAppendError
  | InvalidToolName
  | ToolConflict

export const run = <R = never, E = never>(
  options: RunOptions<R, E>,
): Stream.Stream<AgentEvent, RunStreamError<E>, R> =>
  Stream.callback<AgentEvent, RunStreamError<E>>((queue) => {
    // Innermost journal span still open; drives cause-time closing in one place.
    let openSpan: "turn" | "step" | "none" = "none"
    const emit = (event: AgentEvent) => Queue.offer(queue, event)

    const appendUserPrompt = (prompt: string) =>
      Effect.gen(function* () {
        yield* options.append({ _tag: "user/message", content: prompt })
        const promptObj = Prompt.make(prompt)
        yield* Ref.update(options.chat.history, (history) => Prompt.concat(history, promptObj))
      })

    interface StepPosition {
      readonly turn: number
      readonly step: number
      readonly stepIndex: number
    }

    /** Executes a single step: one model request and its corresponding tool calls. */
    const executeStep = (
      position: StepPosition,
      deps: { readonly policy: ResolvedRunPolicy; readonly scheduler: ToolScheduler },
    ): Effect.Effect<
      StepOutcome,
      AiError.AiError | StepRejected | RunError | JournalAppendError
    > => {
      const context: RunContext = {
        sessionId: options.sessionId,
        turn: position.turn,
        step: position.step,
      }
      const { policy, scheduler } = deps

      // SAFETY: the compatibility step contract closes the existential agent
      // channels after plan finalization; Runtime exposes those channels.
      return Effect.gen(function* () {
        yield* options.append({ _tag: "step/start", index: position.stepIndex })
        openSpan = "step"

        const pendingSteer = yield* options.interrupt.pollSteer
        if (Option.isSome(pendingSteer)) {
          yield* options.append({ _tag: "step/end", reason: "interrupted" })
          openSpan = "turn"
          return {
            _tag: "Steered" as const,
            steerPrompt: pendingSteer.value,
          }
        }

        const preStep = yield* Effect.raceFirst(
          options.hooks.preStep(context).pipe(Effect.as({ _tag: "Ok" as const })),
          options.interrupt.awaitSignal,
        )
        if (preStep._tag === "Interrupted") {
          yield* options.append({ _tag: "step/end", reason: "interrupted" })
          openSpan = "turn"
          return { _tag: "Interrupted" as const }
        }
        if (preStep._tag === "Steered") {
          yield* options.append({ _tag: "step/end", reason: "interrupted" })
          openSpan = "turn"
          return {
            _tag: "Steered" as const,
            steerPrompt: preStep.steerPrompt,
          }
        }

        const correlator = makeToolCallCorrelator({
          sessionId: options.sessionId.toString(),
          turn: position.turn,
          step: position.step,
        })

        const preStepHistory = yield* Ref.get(options.chat.history)
        let toolkit = yield* options.toolkit
        let modelPrompt: Prompt.Prompt | undefined
        let planAudit:
          | {
              readonly planId: string
              readonly fingerprint: string
              readonly toolNames: ReadonlyArray<string>
            }
          | undefined
        if (options.agent !== undefined) {
          const agentContext: AgentContext = {
            sessionId: options.sessionId.toString(),
            runId: options.runId ?? options.sessionId.toString(),
            turn: position.turn,
            step: position.step,
            history: preStepHistory,
          }
          // This is the single render point for one logical model request.
          const plan = yield* options.agent.render(agentContext)
          const finalized = yield* plan.tools.finalize
          toolkit = finalized.toolkit
          modelPrompt = planToPrompt(plan, preStepHistory)
          const planId = `${options.agent.name}:${position.turn}:${position.step}`
          planAudit = {
            planId,
            toolNames: finalized.tools.map((tool) => tool.name),
            fingerprint: requestFingerprint({
              planId,
              prompt: modelPrompt,
              toolNames: finalized.tools.map((tool) => tool.name),
            }),
          }
        }
        const collectedParts: Array<Response.StreamPart<Record<string, Tool.Any>>> = []
        let attemptState: AttemptState = {
          emittedModelPart: false,
          toolDispatchStarted: false,
        }
        type ModelOutcome =
          | ControlSignal
          | {
              readonly _tag: "Done"
              readonly parts: ReadonlyArray<Response.StreamPart<Record<string, Tool.Any>>>
            }
        const runAttempt = (
          attempt: number,
          recordAudit: boolean,
        ): Effect.Effect<ModelOutcome, RunStreamError<E>, R> => {
          collectedParts.length = 0
          const interceptedToolkit = asClosedToolkit(
            interceptToolkit(
              toolkit,
              options.hooks,
              () => context,
              emit,
              scheduler,
              correlator,
              policy,
              () => {
                attemptState = { ...attemptState, toolDispatchStarted: true }
              },
            ),
          )
          const logicalRequest: LogicalModelRequest | undefined =
            options.agent === undefined
              ? undefined
              : {
                  planId: planAudit!.planId,
                  fingerprint: planAudit!.fingerprint,
                  prompt: modelPrompt ?? preStepHistory,
                  /* SAFETY: the registry erased tool names once; Effect AI
                   * still validates each call against the same definitions. */
                  /* oxlint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/no-escape-hatch-assertions -- SAFETY: this is the single Effect AI toolkit erasure boundary after registry validation. */
                  /* SAFETY: the registry validated these definitions before
                   * the single Effect AI toolkit erasure boundary. */
                  toolkit: interceptedToolkit as unknown as Toolkit.WithHandler<
                    Record<string, Tool.Any>
                  >,
                }
          if (logicalRequest !== undefined) {
            options.attemptPolicy?.onAttempt?.(logicalRequest, attempt)
          }
          const interceptedModel = interceptModel(
            options.model,
            options.hooks,
            () => context,
            options.append,
            planAudit === undefined ? undefined : { ...planAudit, attempt },
            options.agent !== undefined ? true : recordAudit,
          )
          const modelStream =
            options.agent === undefined
              ? options.chat
                  .streamText({
                    prompt: [],
                    toolkit: interceptedToolkit,
                    concurrency: "unbounded",
                  })
                  .pipe(Stream.provideService(LanguageModel.LanguageModel, interceptedModel))
              : Stream.unwrap(
                  modelAttempt(logicalRequest!, attempt).pipe(
                    Effect.map((result) => result.stream),
                    Effect.provideService(LanguageModel.LanguageModel, interceptedModel),
                  ),
                )
          const observed = modelStream.pipe(
            Stream.provideService(AgentEmit, { emit }),
            Stream.tap((part) => {
              attemptState = { ...attemptState, emittedModelPart: true }
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
              return event === undefined ? Effect.void : emit(event)
            }),
          )
          const collectStream = observed.pipe(
            Stream.runCollect,
            Effect.map((parts) => [...parts]),
          )
          const timedStepStream =
            policy.modelTimeout === undefined
              ? collectStream
              : collectStream.pipe(Effect.timeout(policy.modelTimeout))
          const explicit = options.agent !== undefined
          /* oxlint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/no-escape-hatch-assertions -- SAFETY: this is the single model result erasure boundary after the explicit/compatibility branch is selected. */
          const admitted = (explicit
            ? timedStepStream
            : timedStepStream.pipe(
                Effect.mapError((cause) =>
                  runError(cause, { sessionId: options.sessionId }, "model"),
                ),
                /* oxlint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/no-escape-hatch-assertions -- SAFETY: the branch above supplies the exact model response stream; this cast only joins compatibility and explicit errors. */
                /* SAFETY: the branch above supplies the exact model response
                 * stream; this cast only joins compatibility and explicit errors. */
              )) as unknown as Effect.Effect<
            ReadonlyArray<Response.StreamPart<Record<string, Tool.Any>>>,
            RunStreamError<E>,
            R
          >
          // SAFETY: admitted is narrowed to the model response contract above;
          // raceFirst only adds the existing interrupt control signal.
          return Effect.raceFirst(
            admitted.pipe(Effect.map((parts) => ({ _tag: "Done" as const, parts }))),
            options.interrupt.awaitSignal,
          ) as Effect.Effect<ModelOutcome, RunStreamError<E>, R>
        }

        const attemptPolicy = options.attemptPolicy ?? defaultModelAttemptPolicy
        let attempt = 1
        let outcome: ModelOutcome
        while (true) {
          attemptState = { emittedModelPart: false, toolDispatchStarted: false }
          const result = yield* Effect.exit(runAttempt(attempt, attempt === 1))
          if (Exit.isSuccess(result)) {
            outcome = result.value
            break
          }
          const retry =
            options.agent !== undefined &&
            attempt < Math.max(1, Math.floor(attemptPolicy.maxAttempts)) &&
            (attemptPolicy.shouldRetry?.(result.cause, attemptState, attempt) ??
              canRetryAttempt(attemptState))
          if (!retry) return yield* Effect.failCause(result.cause)
          attempt += 1
        }

        if (outcome._tag === "Interrupted") {
          yield* options.append({ _tag: "step/end", reason: "interrupted" })
          openSpan = "turn"
          return { _tag: "Interrupted" as const }
        }

        if (outcome._tag === "Steered") {
          closeOpenParts(collectedParts)
          yield* Ref.set(
            options.chat.history,
            Prompt.concat(preStepHistory, Prompt.fromResponseParts(collectedParts)),
          )
          yield* appendStepEvents(options.append, collectedParts)
          yield* options.append({ _tag: "step/end", reason: "interrupted" })
          openSpan = "turn"
          return {
            _tag: "Steered" as const,
            steerPrompt: outcome.steerPrompt,
          }
        }

        if (options.agent !== undefined) {
          // Direct LanguageModel calls do not own Chat history. The logical
          // response becomes the immutable input for the next request.
          yield* Ref.set(
            options.chat.history,
            Prompt.concat(preStepHistory, Prompt.fromResponseParts(outcome.parts)),
          )
        }
        yield* appendStepEvents(options.append, outcome.parts)
        yield* options.append({ _tag: "step/end", reason: "completed" })
        openSpan = "turn"

        const toolCalls = outcome.parts.filter((part) => part.type === "tool-call")
        if (toolCalls.length > 0) {
          return { _tag: "ToolCalls" as const, toolCallCount: toolCalls.length }
        }

        return { _tag: "Stop" as const }
      }) as Effect.Effect<
        StepOutcome,
        AiError.AiError | StepRejected | RunError | JournalAppendError,
        never
      >
    }

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
        openSpan = "turn"

        let turnEnded = false

        while (true) {
          step += 1
          stepIndex += 1
          const outcome = yield* executeStep({ turn, step, stepIndex }, { policy, scheduler })
          if (outcome._tag === "Interrupted") {
            yield* options.append({ _tag: "turn/end", reason: "interrupted" })
            openSpan = "none"
            yield* emit({ _tag: "Finish", reason: "interrupted" })
            return
          }
          if (outcome._tag === "Steered") {
            yield* options.append({ _tag: "turn/end", reason: "interrupted" })
            openSpan = "none"
            yield* appendUserPrompt(outcome.steerPrompt)
            turnEnded = true
            break
          }

          totalSteps += 1
          const reachedLimit = totalSteps >= policy.maxTotalSteps || step >= policy.maxStepsPerTurn
          if (reachedLimit && outcome._tag === "ToolCalls") {
            yield* options.append({ _tag: "turn/end", reason: "stopped" })
            openSpan = "none"
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
          openSpan = "none"
          yield* emit({ _tag: "Finish", reason: "interrupted" })
          return
        }

        if (turnContinuation._tag === "Steered") {
          yield* options.append({ _tag: "turn/end", reason: "interrupted" })
          openSpan = "none"
          yield* appendUserPrompt(turnContinuation.steerPrompt)
          continue
        }

        yield* options.append({ _tag: "turn/end", reason: "completed" })
        openSpan = "none"
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

    /** Close whatever journal spans are still open when the body escapes. */
    const closeOpenSpans = (
      reason: "interrupted" | "failed",
      message?: string,
    ): Effect.Effect<void, RunError | JournalAppendError> =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          if (openSpan === "step") {
            yield* options.append(
              message === undefined
                ? { _tag: "step/end", reason }
                : { _tag: "step/end", reason, message },
            )
            openSpan = "turn"
          }
          if (openSpan === "turn") {
            yield* options.append(
              message === undefined
                ? { _tag: "turn/end", reason }
                : { _tag: "turn/end", reason, message },
            )
            openSpan = "none"
          }
        }),
      )

    const failQueue = (cause: Cause.Cause<unknown>) => {
      if (options.agent !== undefined) {
        // SAFETY: explicit runs preserve the original typed cause; the queue
        // error channel is the declared RunStreamError union.
        return Queue.failCause(queue, cause as Cause.Cause<RunStreamError<E>>)
      }
      return Queue.fail(queue, runError(cause, { sessionId: options.sessionId }))
    }

    return body.pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          const message = Cause.pretty(cause).trim()
          const cleanup = yield* Effect.exit(closeOpenSpans("failed", message))
          if (Exit.isFailure(cleanup)) {
            // Cleanup failures are operational failures too: fail the callback
            // explicitly rather than allowing the finalizer to end it normally.
            yield* failQueue(cleanup.cause)
            return
          }
          yield* emit({ _tag: "Finish", reason: "failed", message }).pipe(Effect.ignore)
          yield* failQueue(cause)
        }),
      ),
      // Interruption bypasses catchCause: a Prompt consumer drop interrupts
      // this fiber directly. Close spans and publish Finish so subscribers
      // are not left waiting on takeUntil(Finish).
      Effect.onInterrupt(() =>
        Effect.gen(function* () {
          const cleanup = yield* Effect.exit(closeOpenSpans("interrupted"))
          if (Exit.isFailure(cleanup)) {
            yield* failQueue(cleanup.cause)
            return
          }
          yield* emit({ _tag: "Finish", reason: "interrupted" }).pipe(Effect.ignore)
        }),
      ),
      Effect.ensuring(Queue.end(queue)),
      Effect.asVoid,
    )
  })
