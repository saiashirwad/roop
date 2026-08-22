/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-escape-hatch-assertions, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: these assertions are limited to the compatibility and Effect AI existential boundaries described below. */

import { Cause, Duration, Effect, Exit, Option, Queue, Ref, Stream } from "effect"
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
import { toPrompt as planToPrompt } from "../AgentPlan.ts"
import type { RunId, SessionId } from "../DomainIds.ts"
import { ModelTimeout, runError, UnsafeModelRetry, type RunError } from "../Error.ts"
import type { JournalAppendError } from "../Journal.ts"
import {
  empty as emptyMiddleware,
  type Middleware,
  type ModelCallInput,
  type ToolCallInput,
  type TurnRunInput,
} from "../Middleware.ts"
import { resolveRunPolicy, type ResolvedRunPolicy, type RunPolicy } from "../RunPolicy.ts"
import type { FinalizedToolkit, InvalidToolName, ToolConflict } from "../ToolRegistry.ts"
import {
  modelAttempt,
  planFingerprint,
  promptFingerprint,
  requestFingerprint,
  toolFingerprint,
  type LogicalModelRequest,
} from "./effectAiAdapter.ts"
import { makeToolCallCorrelator } from "./toolCallCorrelator.ts"
import { makeToolScheduler, type ToolScheduler } from "./toolScheduler.ts"

export interface RunOptions<R = never, E = never> {
  readonly sessionId: SessionId
  readonly chat: Chat.Service
  readonly model: LanguageModel.Service
  /** A request-bound capability snapshot. */
  readonly toolkit: Effect.Effect<ErasedToolkit>
  readonly policy?: RunPolicy | undefined
  readonly append: (event: SessionEvent) => Effect.Effect<void, RunError | JournalAppendError>
  readonly middleware?: Middleware | undefined
  /** Explicit agent used by the staged logical-plan interpreter path. */
  readonly agent?: AgentDefinition<R, E> | undefined
  /** Stable run identity supplied to the agent renderer. */
  readonly runId?: RunId | undefined
}

interface RunContext {
  readonly sessionId: SessionId
  readonly turn: number
  readonly step: number
}

type ErasedToolkit = FinalizedToolkit

/** Outcome of one step, as the turn loop sees it. */
type StepOutcome =
  | { readonly _tag: "Stop" }
  | { readonly _tag: "ToolCalls"; readonly toolCallCount: number }

type ToolCallParameters = Tool.Parameters<Tool.Any>

/** Toolkit shape used only to keep `Tool.Any` handler services off Effect channels. */
type ClosedToolkit = Toolkit.WithHandler<Record<string, never>>

interface ClosedToolkitValue {}

const asClosedToolkit = (toolkit: ClosedToolkitValue): ClosedToolkit => {
  /* SAFETY: Tool handlers are already installed; this closes their `any` service channel. */
  return toolkit as ClosedToolkit
}

/** Journal the exact assistant messages produced by this model response. */
const appendStepEvents = (
  append: (event: SessionEvent) => Effect.Effect<void, RunError | JournalAppendError>,
  outcome: ReadonlyArray<Response.StreamPart<Record<string, Tool.Any>>>,
): Effect.Effect<void, RunError | JournalAppendError> => {
  const content = Prompt.fromResponseParts(outcome).content
  const events: Array<SessionEvent> = []
  for (const message of content) {
    if (message.role === "assistant") {
      const parts = message.content
        .filter((part) => part.type === "text" || part.type === "reasoning")
        .map((part) => ({ type: part.type, text: part.text }))
      if (parts.length > 0) events.push({ _tag: "assistant/message", parts })
    }
  }
  return Effect.forEach(events, append, { discard: true })
}

/** `beforeRequest` rewrites only model-facing prompt options. */
const interceptModel = (
  model: LanguageModel.Service,
  append: (event: SessionEvent) => Effect.Effect<void, RunError | JournalAppendError>,
  audit?: {
    readonly planId: string
    readonly planFingerprint: string
    readonly toolFingerprint: string
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
          const admitted = {
            prompt: request.prompt,
            toolChoice: request.toolChoice,
          }
          if (recordAudit) {
            const promptObj = Prompt.isPrompt(admitted.prompt)
              ? admitted.prompt
              : Prompt.make(admitted.prompt)
            const promptFp = promptFingerprint(promptObj)
            const reqFingerprint = requestFingerprint({
              planId: audit?.planId,
              planFingerprint: audit?.planFingerprint,
              prompt: promptObj,
              toolNames: audit?.toolNames ?? [],
            })
            yield* append({
              _tag: "model/request",
              request:
                audit === undefined
                  ? admitted
                  : {
                      ...admitted,
                      planId: audit.planId,
                      fingerprint: reqFingerprint,
                      planFingerprint: audit.planFingerprint,
                      promptFingerprint: promptFp,
                      toolFingerprint: audit.toolFingerprint,
                      toolNames: audit.toolNames,
                      ...(audit.attempt === undefined ? undefined : { attempt: audit.attempt }),
                    },
            })
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
      )) as unknown as LanguageModel.Service["streamText"],
  }
}

/**
 * The denial envelope effect/unstable/ai itself uses for refused tool calls;
 * the model sees a failed result and the run continues.
 */
/* oxlint-disable-next-line anti-slop/no-unknown-parameters -- encoded tool results are schema-erased at this boundary. */
const encodedBytes = (value: unknown): number => {
  const json = JSON.stringify(value)
  return json === undefined ? 0 : new TextEncoder().encode(json).byteLength
}

const outputTooLarge = (maxBytes: number) => ({
  type: "tool-output-too-large" as const,
  message: `tool output exceeded ${maxBytes} bytes`,
})

const toolTimedOut = {
  type: "tool-timeout" as const,
  message: "tool execution timed out",
}

/** `beforeToolExecute`/`afterToolExecute` seams: `WithHandler.handle` is the single choke point. */
const interceptToolkit = (
  toolkit: ErasedToolkit,
  middleware: Middleware,
  context: () => RunContext,
  emit: (event: AgentEvent) => Effect.Effect<void>,
  scheduler: ToolScheduler,
  correlator: ReturnType<typeof makeToolCallCorrelator>,
  policy: Pick<ResolvedRunPolicy, "toolTimeout" | "maxToolOutputBytes">,
  append: (event: SessionEvent) => Effect.Effect<void, RunError | JournalAppendError>,
  onToolDispatch: () => Effect.Effect<void>,
): ErasedToolkit => {
  /* SAFETY: The intercept preserves ErasedToolkit.handle while inserting hook seams. */
  return {
    tools: toolkit.tools,
    handle: ((name: string, params: ToolCallParameters) =>
      Effect.gen(function* () {
        // Allocate the token before scheduler wait. LanguageModel starts concurrent
        // handlers in provider-part order, but hook/scheduling timing may vary; the token
        // must represent invocation order, not execution timing.
        const token = correlator.allocateToken(name)
        yield* onToolDispatch()
        yield* append({
          _tag: "tool/call",
          id: token,
          name,
          params,
          providerExecuted: false,
        })
        yield* emit({
          _tag: "ToolCall",
          id: token,
          name,
          params,
          providerExecuted: false,
        })
        const baseToolCall = (input: ToolCallInput) =>
          scheduler.scheduleEffect(
            Effect.suspend(() =>
              toolkit.handle(input.name, input.params).pipe(
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
          )
        const toolInput: ToolCallInput = {
          sessionId: context().sessionId.toString(),
          turn: context().turn,
          step: context().step,
          name,
          params,
        }
        const wrapped = middleware.tool(baseToolCall)(toolInput)
        const timed = Option.isNone(policy.toolTimeout)
          ? wrapped
          : wrapped.pipe(
              Stream.mergeEffect(
                Effect.sleep(policy.toolTimeout.value).pipe(
                  Effect.andThen(Effect.fail({ _tag: "ToolTimeoutSignal" as const })),
                ),
              ),
              Stream.catchTag("ToolTimeoutSignal", () =>
                Stream.make({
                  result: toolTimedOut,
                  encodedResult: toolTimedOut,
                  isFailure: true,
                  preliminary: false,
                }),
              ),
            )
        const maxBytesOpt = policy.maxToolOutputBytes
        const bounded = Option.isSome(maxBytesOpt)
          ? Stream.map(timed, (result) => {
              if (result.preliminary || encodedBytes(result.encodedResult) <= maxBytesOpt.value)
                return result
              const failure = outputTooLarge(maxBytesOpt.value)
              return { ...result, result: failure, encodedResult: failure, isFailure: true }
            })
          : timed
        return bounded.pipe(
          Stream.tap((result) => {
            if (result.preliminary) return Effect.void
            return Effect.gen(function* () {
              yield* append({
                _tag: "tool/result",
                id: token,
                name,
                isFailure: result.isFailure,
                result: result.encodedResult,
                providerExecuted: false,
              })
              yield* emit({
                _tag: "ToolResult",
                id: token,
                name,
                isFailure: result.isFailure,
                result: result.encodedResult,
                providerExecuted: false,
              })
            })
          }),
        )
      })) as unknown as ErasedToolkit["handle"],
  }
}

/**
 * Executes a run — the turn/step loop over one model, with journal spans,
 * tool interception, and the single terminal Finish event — behind one interface.
 */
type RunStreamError<E> =
  | E
  | AiError.AiError
  | RunError
  | JournalAppendError
  | InvalidToolName
  | ToolConflict
  | UnsafeModelRetry
  | ModelTimeout

export const run = <R = never, E = never>(
  options: RunOptions<R, E>,
): Stream.Stream<AgentEvent, RunStreamError<E>, R> =>
  Stream.callback<AgentEvent, RunStreamError<E>>((queue) => {
    const middleware = options.middleware ?? emptyMiddleware
    // Innermost journal span still open; drives cause-time closing in one place.
    let openSpan: "turn" | "step" | "none" = "none"
    const emit = (event: AgentEvent) => Queue.offer(queue, event)

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
      AiError.AiError | RunError | JournalAppendError | ModelTimeout
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
              readonly planFingerprint: string
              readonly toolFingerprint: string
              readonly toolNames: ReadonlyArray<string>
            }
          | undefined
        if (options.agent !== undefined) {
          const agentContext: AgentContext = {
            sessionId: options.sessionId,
            runId: options.runId ?? (options.sessionId as unknown as RunId),
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
          const pFingerprint = planFingerprint({
            instructions: plan.instructions,
            tools: finalized.tools,
          })
          const tFingerprint = toolFingerprint(finalized.tools)
          const toolNames = finalized.tools.map((tool) => tool.name)
          planAudit = {
            planId,
            planFingerprint: pFingerprint,
            toolFingerprint: tFingerprint,
            toolNames,
          }
        }
        const collectedParts: Array<Response.StreamPart<Record<string, Tool.Any>>> = []
        const attemptStateRef = yield* Ref.make({
          active: false,
          outputObserved: false,
          toolDispatchStarted: false,
        })
        const interceptedToolkit = asClosedToolkit(
          interceptToolkit(
            toolkit,
            middleware,
            () => context,
            emit,
            scheduler,
            correlator,
            policy,
            options.append,
            () => Ref.update(attemptStateRef, (state) => ({ ...state, toolDispatchStarted: true })),
          ),
        )
        const logicalRequest: LogicalModelRequest | undefined =
          options.agent === undefined
            ? undefined
            : {
                planId: planAudit!.planId,
                fingerprint: requestFingerprint({
                  planId: planAudit!.planId,
                  planFingerprint: planAudit!.planFingerprint,
                  prompt: modelPrompt ?? preStepHistory,
                  toolNames: planAudit!.toolNames,
                }),
                prompt: modelPrompt ?? preStepHistory,
                /* SAFETY: the registry validated these definitions before
                 * the single Effect AI toolkit erasure boundary. */
                toolkit: interceptedToolkit as unknown as Toolkit.WithHandler<
                  Record<string, Tool.Any>
                >,
              }
        const baseModelCall = (
          input: ModelCallInput,
        ): Stream.Stream<
          Response.StreamPart<Record<string, Tool.Any>>,
          AiError.AiError | RunError | JournalAppendError | UnsafeModelRetry,
          never
        > =>
          Stream.unwrap(
            Effect.gen(function* () {
              const canStart = yield* Ref.modify(attemptStateRef, (state) => {
                if (state.active || state.outputObserved || state.toolDispatchStarted) {
                  return [false, state]
                }
                return [true, { ...state, active: true }]
              })
              if (!canStart) {
                return Stream.fail(
                  new UnsafeModelRetry({
                    sessionId: context.sessionId,
                    turn: context.turn,
                    step: context.step,
                    attempt: input.attempt,
                  }),
                ) as Stream.Stream<
                  Response.StreamPart<Record<string, Tool.Any>>,
                  AiError.AiError | RunError | JournalAppendError | UnsafeModelRetry,
                  never
                >
              }
              collectedParts.length = 0
              const interceptedModel = interceptModel(
                input.model ?? options.model,
                options.append,
                planAudit === undefined
                  ? undefined
                  : {
                      ...planAudit,
                      attempt: input.attempt,
                    },
                true,
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
                      modelAttempt(
                        { ...logicalRequest!, prompt: input.prompt },
                        input.attempt,
                      ).pipe(
                        Effect.map((result) => result.stream),
                        Effect.provideService(LanguageModel.LanguageModel, interceptedModel),
                      ),
                    )
              const observed = modelStream.pipe(
                Stream.provideService(AgentEmit, { emit }),
                Stream.tap((part) =>
                  Effect.gen(function* () {
                    yield* Ref.update(attemptStateRef, (state) => ({
                      ...state,
                      outputObserved: true,
                    }))
                    collectedParts.push(part)

                    if (part.type === "tool-call" && part.providerExecuted) {
                      const localIdOpt = correlator.observeProviderCall({
                        id: part.id,
                        name: part.name,
                        providerExecuted: true,
                        isKnownTool: toolkit.tools[part.name] !== undefined,
                      })
                      const localId = Option.isSome(localIdOpt) ? localIdOpt.value : part.id
                      yield* options.append({
                        _tag: "tool/call",
                        id: localId,
                        name: part.name,
                        params: part.params as ToolCallParameters,
                        providerExecuted: true,
                      })
                      yield* emit({
                        _tag: "ToolCall",
                        id: localId,
                        name: part.name,
                        params: part.params,
                        providerExecuted: true,
                      })
                    } else if (
                      part.type === "tool-result" &&
                      part.providerExecuted &&
                      !part.preliminary
                    ) {
                      const localIdOpt = correlator.tokenForProviderId(part.id)
                      const localId = Option.isSome(localIdOpt) ? localIdOpt.value : part.id
                      yield* options.append({
                        _tag: "tool/result",
                        id: localId,
                        name: part.name,
                        isFailure: part.isFailure,
                        result: part.encodedResult,
                        providerExecuted: true,
                      })
                      yield* emit({
                        _tag: "ToolResult",
                        id: localId,
                        name: part.name,
                        isFailure: part.isFailure,
                        result: part.encodedResult,
                        providerExecuted: true,
                      })
                    } else if (part.type === "text-delta") {
                      yield* emit({ _tag: "TextDelta", delta: part.delta })
                    } else if (part.type === "reasoning-delta") {
                      yield* emit({ _tag: "ReasoningDelta", delta: part.delta })
                    }
                  }),
                ),
              )
              const guarded: Stream.Stream<
                Response.StreamPart<Record<string, Tool.Any>>,
                AiError.AiError | RunError | JournalAppendError,
                never
              > = options.agent === undefined
                ? observed.pipe(
                    Stream.mapError((cause) =>
                      runError(cause, { sessionId: options.sessionId }, "model"),
                    ),
                  )
                : observed
              return guarded.pipe(
                Stream.ensuring(
                  Ref.update(attemptStateRef, (state) => ({ ...state, active: false })),
                ),
              )
            }),
          )
        const modelInput: ModelCallInput = {
          sessionId: context.sessionId.toString(),
          turn: context.turn,
          step: context.step,
          prompt: modelPrompt ?? preStepHistory,
          attempt: 1,
          ...(planAudit === undefined ? undefined : planAudit),
        }
        const modelStream = middleware.model(baseModelCall)(modelInput)
        const collectModel = modelStream.pipe(
          Stream.runCollect,
          Effect.map((parts) => [...parts]),
        )
        const modelTimeoutOpt = policy.modelTimeout
        const timedModel = Option.isNone(modelTimeoutOpt)
          ? collectModel
          : collectModel.pipe(
              Effect.timeout(modelTimeoutOpt.value),
              Effect.catchTag("TimeoutError", () =>
                Effect.fail(
                  new ModelTimeout({
                    sessionId: options.sessionId,
                    turn: position.turn,
                    step: position.step,
                    durationMillis: Duration.toMillis(modelTimeoutOpt.value),
                  }),
                ),
              ),
            )
        const outcomeParts = yield* timedModel

        if (options.agent !== undefined) {
          // Direct LanguageModel calls do not own Chat history. The logical
          // response becomes the immutable input for the next request.
          yield* Ref.set(
            options.chat.history,
            Prompt.concat(preStepHistory, Prompt.fromResponseParts(outcomeParts)),
          )
        }
        yield* appendStepEvents(options.append, outcomeParts)
        yield* options.append({ _tag: "step/end", reason: "completed" })
        openSpan = "turn"

        const toolCalls = outcomeParts.filter((part) => part.type === "tool-call")
        if (toolCalls.length > 0) {
          return { _tag: "ToolCalls" as const, toolCallCount: toolCalls.length }
        }

        return { _tag: "Stop" as const }
      }) as Effect.Effect<
        StepOutcome,
        AiError.AiError | RunError | JournalAppendError | ModelTimeout,
        never
      >
    }

    const body = Effect.gen(function* () {
      const policy = resolveRunPolicy(options.policy)
      const scheduler = yield* makeToolScheduler(policy.toolConcurrency)
      let turn = 0
      let totalSteps = 0
      let stepIndex = 0

      const executeTurn = (currentTurn: number) =>
        Effect.gen(function* () {
          let step = 0
          yield* options.append({ _tag: "turn/start" })
          openSpan = "turn"

          while (true) {
            step += 1
            stepIndex += 1
            const outcome = yield* middleware.step(() =>
              executeStep({ turn: currentTurn, step, stepIndex }, { policy, scheduler }),
            )({ sessionId: options.sessionId.toString(), turn: currentTurn, step, stepIndex })

            totalSteps += 1
            const reachedLimit =
              totalSteps >= policy.maxTotalSteps || step >= policy.maxStepsPerTurn
            if (reachedLimit && outcome._tag === "ToolCalls") {
              yield* options.append({ _tag: "turn/end", reason: "stopped" })
              openSpan = "none"
              return { _tag: "Stopped" as const, stepCount: step }
            }
            if (outcome._tag === "Stop" || reachedLimit) {
              break
            }
          }

          yield* options.append({ _tag: "turn/end", reason: "completed" })
          openSpan = "none"
          return { _tag: "Completed" as const, stepCount: step }
        })

      while (turn < policy.maxTurns) {
        turn += 1
        const currentTurn = turn
        const turnInput: TurnRunInput = {
          sessionId: options.sessionId.toString(),
          turn: currentTurn,
          step: 0,
          stepCount: 0,
        }

        const turnOutcome = yield* middleware.turn((_input) => executeTurn(currentTurn))(turnInput)

        if (turnOutcome._tag === "Stopped") {
          yield* emit({ _tag: "Finish", reason: "stopped" })
          return
        }
        if (turnOutcome._tag === "Completed") {
          yield* emit({ _tag: "Finish", reason: "completed" })
          return
        }
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
