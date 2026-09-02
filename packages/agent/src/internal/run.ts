/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-escape-hatch-assertions -- the intercepted toolkit is the one place the interpreter re-enters the Effect AI handler existential. */

import { Cause, Duration, Effect, Exit, Option, Queue, Ref, Stream } from "effect"
import { Prompt, type AiError, type LanguageModel, type Response } from "effect/unstable/ai"
import type * as Tool from "effect/unstable/ai/Tool"

import type { AgentDefinition } from "../Agent.ts"
import { AgentEmit, type AgentEvent } from "../AgentEvents.ts"
import { toPrompt as planToPrompt } from "../AgentPlan.ts"
import type { RunId, SessionId } from "../DomainIds.ts"
import { ModelTimeout, UnsafeModelRetry } from "../Error.ts"
import {
  EVENT_VERSION,
  type FinishReason,
  type Json,
  type JournalEvent,
  type LifecycleState,
} from "../Event.ts"
import type { JournalAppendError } from "../Journal.ts"
import type { Middleware, ModelCallInput, ToolCallInput } from "../Middleware.ts"
import type { ResolvedRunPolicy } from "../RunPolicy.ts"
import { ToolExecutionContext, type ToolExecutionContextService } from "../ToolExecutionContext.ts"
import type { FinalizedToolkit, InvalidToolName, ToolConflict } from "../ToolRegistry.ts"
import {
  planFingerprint,
  requestFingerprint,
  streamModel,
  toJson,
  toolDescriptors,
  toolFingerprint,
} from "./effectAiAdapter.ts"
import { makeToolCallCorrelator } from "./toolCallCorrelator.ts"
import { makeToolScheduler, type ToolScheduler } from "./toolScheduler.ts"

/** Commit semantic events to the journal. An empty batch is a no-op. */
export type AppendEvents = (
  events: ReadonlyArray<JournalEvent>,
) => Effect.Effect<void, JournalAppendError>

export interface RunOptions<R, E> {
  readonly sessionId: SessionId
  readonly runId: RunId
  readonly agent: AgentDefinition<R, E>
  /** The model-visible conversation. Each step reads it and appends its response. */
  readonly history: Ref.Ref<Prompt.Prompt>
  readonly model: LanguageModel.Service
  readonly policy: ResolvedRunPolicy
  readonly middleware: Middleware
  readonly append: AppendEvents
}

export type RunStreamError<E> =
  | E
  | AiError.AiError
  | JournalAppendError
  | InvalidToolName
  | ToolConflict
  | UnsafeModelRetry
  | ModelTimeout

type Part = Response.StreamPart<Record<string, Tool.Any>>

type StepOutcome =
  | { readonly _tag: "Stop" }
  | { readonly _tag: "ToolCalls"; readonly toolCallCount: number }

type TurnOutcome = { readonly _tag: "Completed" | "Stopped"; readonly stepCount: number }

/** Attempt bookkeeping for one step. `open` is the attempt the journal has not closed yet. */
interface AttemptState {
  readonly active: boolean
  readonly outputObserved: boolean
  readonly toolDispatchStarted: boolean
  readonly open: Option.Option<number>
}

interface StepAt {
  readonly runId: RunId
  readonly turn: number
  readonly step: number
}

interface SpanOutcome {
  readonly reason: FinishReason
  readonly message?: string | undefined
}

const V = { version: EVENT_VERSION } as const

const terminalState = (reason: FinishReason): LifecycleState =>
  reason === "completed" ? "completed" : "aborted"

const withMessage = (message: string | undefined) =>
  message === undefined ? undefined : { message }

/** Map how a span's fiber ended onto the journal's terminal reason. */
const exitOutcome = <A, E>(exit: Exit.Exit<A, E>, onSuccess: (a: A) => FinishReason): SpanOutcome =>
  Exit.isSuccess(exit)
    ? { reason: onSuccess(exit.value) }
    : Cause.hasInterruptsOnly(exit.cause)
      ? { reason: "interrupted" }
      : { reason: "failed", message: Cause.pretty(exit.cause).trim() }

const stepEvent = (at: StepAt, outcome: SpanOutcome | "started"): JournalEvent =>
  outcome === "started"
    ? { _tag: "step", ...V, ...at, state: "started" }
    : {
        _tag: "step",
        ...V,
        ...at,
        state: terminalState(outcome.reason),
        reason: outcome.reason,
        ...withMessage(outcome.message),
      }

const attemptEvent = (
  at: StepAt,
  attempt: number,
  state: LifecycleState,
  message?: string,
): JournalEvent => ({
  _tag: "model/attempt",
  ...V,
  ...at,
  attempt,
  requestId: `${at.runId}:${at.turn}:${at.step}`,
  state,
  ...withMessage(message),
})

const toolCallEvents = (
  at: StepAt,
  call: { readonly id: string; readonly name: string; readonly params: unknown },
  providerExecuted: boolean,
): ReadonlyArray<JournalEvent> => [
  { _tag: "tool", ...V, ...at, id: call.id, name: call.name, state: "started" },
  {
    _tag: "tool/call",
    ...V,
    ...at,
    id: call.id,
    name: call.name,
    params: toJson(call.params),
    providerExecuted,
  },
]

const toolResultEvents = (
  at: StepAt,
  result: { readonly id: string; readonly name: string; readonly isFailure: boolean },
  encoded: Json,
  providerExecuted: boolean,
): ReadonlyArray<JournalEvent> => [
  {
    _tag: "tool/result",
    ...V,
    ...at,
    id: result.id,
    name: result.name,
    isFailure: result.isFailure,
    result: encoded,
    providerExecuted,
  },
  {
    _tag: "tool",
    ...V,
    ...at,
    id: result.id,
    name: result.name,
    state: result.isFailure ? "aborted" : "completed",
    isFailure: result.isFailure,
    result: encoded,
  },
]

/** The complete assistant messages of one model response. Token deltas are live-only. */
const assistantMessageEvents = (response: Prompt.Prompt): ReadonlyArray<JournalEvent> =>
  response.content.flatMap((message) => {
    if (message.role !== "assistant") return []
    const parts = message.content
      .filter((part) => part.type === "text" || part.type === "reasoning")
      .map((part) => ({ type: part.type, text: part.text }))
    return parts.length === 0 ? [] : [{ _tag: "assistant/message", ...V, parts }]
  })

const textEncoder = new TextEncoder()
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- encoded tool results are schema-erased at this boundary.
const encodedBytes = (value: unknown): number => {
  const json = JSON.stringify(value)
  return json === undefined ? 0 : textEncoder.encode(json).byteLength
}

const outputTooLarge = (maxBytes: number) => ({
  type: "tool-output-too-large" as const,
  message: `tool output exceeded ${maxBytes} bytes`,
})

const toolTimedOut = {
  type: "tool-timeout" as const,
  message: "tool execution timed out",
}

/**
 * Executes a run: one turn of model steps over one agent, with journal spans,
 * tool interception, and a single terminal `Finish` event.
 */
export const run = <R, E>(
  options: RunOptions<R, E>,
): Stream.Stream<AgentEvent, RunStreamError<E>, R> =>
  Stream.callback<AgentEvent, RunStreamError<E>, R>((queue) => {
    const { agent, append, middleware, policy, runId, sessionId } = options
    const emit = (event: AgentEvent): Effect.Effect<void> =>
      Effect.asVoid(Queue.offer(queue, event))

    /** One model request plus the tool calls it produces. */
    const executeStep = Effect.fn("run.executeStep")(function* (
      at: StepAt,
      scheduler: ToolScheduler,
    ) {
      const attempts = yield* Ref.make<AttemptState>({
        active: false,
        outputObserved: false,
        toolDispatchStarted: false,
        open: Option.none(),
      })
      yield* append([stepEvent(at, "started")])
      return yield* stepBody(at, attempts, scheduler).pipe(
        Effect.scoped,
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            const outcome = exitOutcome(exit, () => "completed")
            const state = yield* Ref.get(attempts)
            yield* append([
              ...Option.toArray(
                Option.map(state.open, (attempt) =>
                  attemptEvent(at, attempt, terminalState(outcome.reason), outcome.message),
                ),
              ),
              stepEvent(at, outcome),
            ])
          }),
        ),
      )
    })

    const stepBody = Effect.fn("run.stepBody")(function* (
      at: StepAt,
      attempts: Ref.Ref<AttemptState>,
      scheduler: ToolScheduler,
    ) {
      const { turn, step } = at
      const operation = { sessionId: sessionId.toString(), turn, step }
      const preStepHistory = yield* Ref.get(options.history)

      // The single render point for one logical model request.
      const plan = yield* agent.render({ sessionId, runId, turn, step, history: preStepHistory })
      const finalized = yield* plan.tools.finalize
      const descriptors = toolDescriptors(finalized.tools)
      const audit = {
        planId: `${agent.name}:${turn}:${step}`,
        planFingerprint: planFingerprint(plan.instructions, descriptors),
        toolFingerprint: toolFingerprint(descriptors),
        toolNames: finalized.tools.map((tool) => tool.name),
      }
      const correlator = makeToolCallCorrelator({ sessionId: sessionId.toString(), turn, step })

      const recordToolCall = (
        call: { readonly id: string; readonly name: string; readonly params: unknown },
        providerExecuted: boolean,
      ) =>
        append(toolCallEvents(at, call, providerExecuted)).pipe(
          Effect.andThen(emit({ _tag: "ToolCall", ...call, providerExecuted })),
        )

      const recordToolResult = (
        result: {
          readonly id: string
          readonly name: string
          readonly isFailure: boolean
          readonly result: unknown
        },
        providerExecuted: boolean,
      ) =>
        append(toolResultEvents(at, result, toJson(result.result), providerExecuted)).pipe(
          Effect.andThen(emit({ _tag: "ToolResult", ...result, providerExecuted })),
        )

      /** Runtime-owned tool calls: `handle` is the single choke point for every seam. */
      const handle = (name: string, params: Tool.Parameters<Tool.Any>) =>
        Effect.gen(function* () {
          // Allocate the token before the scheduler wait so it reflects invocation order.
          const id = correlator.allocateToken(name)
          yield* Ref.update(attempts, (state) => ({ ...state, toolDispatchStarted: true }))
          yield* recordToolCall({ id, name, params }, false)

          const executionContext: ToolExecutionContextService = {
            sessionId,
            runId,
            turn,
            step,
            callId: id,
          }
          const emitService = {
            emit: (event: AgentEvent) =>
              emit(event._tag === "Subagent" ? { ...event, toolCallId: id } : event),
            toolCallId: id,
          }
          const scheduled = (input: ToolCallInput) =>
            scheduler.scheduleEffect(
              finalized.toolkit.handle(input.name, input.params).pipe(
                Effect.map((stream) =>
                  stream.pipe(
                    Stream.provideService(ToolExecutionContext, executionContext),
                    Stream.provideService(AgentEmit, emitService),
                  ),
                ),
                Effect.provideService(ToolExecutionContext, executionContext),
                Effect.provideService(AgentEmit, emitService),
              ),
            )
          const wrapped = middleware.tool(scheduled)({ ...operation, name, params })
          const timed = Option.match(policy.toolTimeout, {
            onNone: () => wrapped,
            onSome: (duration) =>
              wrapped.pipe(
                Stream.mergeEffect(
                  Effect.sleep(duration).pipe(
                    Effect.andThen(Effect.fail({ _tag: "ToolTimeout" as const })),
                  ),
                ),
                Stream.catchTag("ToolTimeout", () =>
                  Stream.make({
                    result: toolTimedOut,
                    encodedResult: toolTimedOut,
                    isFailure: true,
                    preliminary: false,
                  }),
                ),
              ),
          })
          const bounded = Option.match(policy.maxToolOutputBytes, {
            onNone: () => timed,
            onSome: (maxBytes) =>
              Stream.map(timed, (result) => {
                if (result.preliminary || encodedBytes(result.encodedResult) <= maxBytes) {
                  return result
                }
                const failure = outputTooLarge(maxBytes)
                return { ...result, result: failure, encodedResult: failure, isFailure: true }
              }),
          })
          return bounded.pipe(
            Stream.tap((result) =>
              result.preliminary
                ? Effect.void
                : recordToolResult(
                    { id, name, isFailure: result.isFailure, result: result.encodedResult },
                    false,
                  ),
            ),
          )
        })

      /* SAFETY: hook and journal failures inside a handler stream surface
       * through the model stream; Effect AI treats the handle result as opaque. */
      const intercepted = handle as unknown as FinalizedToolkit["handle"]
      const toolkit: FinalizedToolkit = { ...finalized.toolkit, handle: intercepted }

      const recordAttempt = (input: ModelCallInput) =>
        Effect.gen(function* () {
          const previous = yield* Ref.getAndUpdate(attempts, (state) => ({
            ...state,
            open: Option.some(input.attempt),
          }))
          const events: Array<JournalEvent> = Option.toArray(
            Option.map(previous.open, (attempt) =>
              attemptEvent(at, attempt, "aborted", "physical attempt ended before output"),
            ),
          )
          events.push(attemptEvent(at, input.attempt, "started"))
          // A retry replays the same logical request; only the first attempt records it.
          if (input.attempt === 1) {
            const prompt = toJson(input.prompt)
            const promptFp = JSON.stringify(prompt)
            events.push({
              _tag: "model/request",
              ...V,
              ...at,
              requestId: `${runId}:${turn}:${step}`,
              request: {
                attempt: input.attempt,
                fingerprint: requestFingerprint({ ...audit, promptFingerprint: promptFp }),
                planFingerprint: audit.planFingerprint,
                planId: audit.planId,
                prompt,
                promptFingerprint: promptFp,
                toolFingerprint: audit.toolFingerprint,
                toolNames: audit.toolNames,
              },
              planFingerprint: audit.planFingerprint,
              promptFingerprint: promptFp,
              toolFingerprint: audit.toolFingerprint,
              toolNames: audit.toolNames,
            })
          }
          yield* append(events)
        })

      const observe = (part: Part): Effect.Effect<void, JournalAppendError> =>
        Effect.gen(function* () {
          yield* Ref.update(attempts, (state) =>
            state.outputObserved ? state : { ...state, outputObserved: true },
          )
          switch (part.type) {
            case "text-delta":
              return yield* emit({ _tag: "TextDelta", delta: part.delta })
            case "reasoning-delta":
              return yield* emit({ _tag: "ReasoningDelta", delta: part.delta })
            case "tool-call": {
              if (!part.providerExecuted) return
              const id = Option.getOrElse(
                correlator.observeProviderCall({
                  id: part.id,
                  name: part.name,
                  providerExecuted: true,
                  isKnownTool: finalized.toolkit.tools[part.name] !== undefined,
                }),
                () => part.id,
              )
              return yield* recordToolCall({ id, name: part.name, params: part.params }, true)
            }
            case "tool-result": {
              if (!part.providerExecuted || part.preliminary) return
              const id = Option.getOrElse(correlator.tokenForProviderId(part.id), () => part.id)
              return yield* recordToolResult(
                { id, name: part.name, isFailure: part.isFailure, result: part.encodedResult },
                true,
              )
            }
            default:
              return
          }
        })

      const modelCall = (
        input: ModelCallInput,
      ): Stream.Stream<Part, AiError.AiError | JournalAppendError | UnsafeModelRetry> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const canStart = yield* Ref.modify(attempts, (state) =>
              state.active || state.outputObserved || state.toolDispatchStarted
                ? [false, state]
                : [true, { ...state, active: true }],
            )
            if (!canStart) {
              return yield* new UnsafeModelRetry({ sessionId, turn, step, attempt: input.attempt })
            }
            yield* recordAttempt(input)
            return streamModel(input.model ?? options.model, input.prompt, toolkit).pipe(
              Stream.provideService(AgentEmit, { emit }),
              Stream.tap(observe),
              Stream.ensuring(Ref.update(attempts, (state) => ({ ...state, active: false }))),
            )
          }),
        )

      const collect = Stream.runCollect(
        middleware.model(modelCall)({
          ...operation,
          prompt: planToPrompt(plan, preStepHistory),
          attempt: 1,
          planId: audit.planId,
          planFingerprint: audit.planFingerprint,
          toolNames: audit.toolNames,
        }),
      )
      const parts = yield* Option.match(policy.modelTimeout, {
        onNone: () => collect,
        onSome: (duration) =>
          collect.pipe(
            Effect.timeoutOrElse({
              duration,
              orElse: () =>
                new ModelTimeout({
                  sessionId,
                  turn,
                  step,
                  durationMillis: Duration.toMillis(duration),
                }),
            }),
          ),
      })

      // The logical response becomes the immutable input of the next request.
      const response = Prompt.fromResponseParts(parts)
      yield* Ref.set(options.history, Prompt.concat(preStepHistory, response))
      yield* append(assistantMessageEvents(response))

      const toolCallCount = parts.filter((part) => part.type === "tool-call").length
      return toolCallCount > 0
        ? { _tag: "ToolCalls" as const, toolCallCount }
        : { _tag: "Stop" as const }
    })

    const executeTurn = Effect.fn("run.executeTurn")(function* (
      turn: number,
      scheduler: ToolScheduler,
    ) {
      const at = { runId, turn }
      yield* append([{ _tag: "turn", ...V, ...at, state: "started" }])
      return yield* turnBody(turn, scheduler).pipe(
        Effect.onExit((exit) => {
          const outcome = exitOutcome(exit, (value: TurnOutcome) =>
            value._tag === "Stopped" ? "stopped" : "completed",
          )
          return append([
            {
              _tag: "turn",
              ...V,
              ...at,
              state: terminalState(outcome.reason),
              reason: outcome.reason,
              ...withMessage(outcome.message),
            },
          ])
        }),
      )
    })

    const turnBody = Effect.fn("run.turnBody")(function* (turn: number, scheduler: ToolScheduler) {
      let step = 0
      while (true) {
        step += 1
        const at: StepAt = { runId, turn, step }
        const outcome: StepOutcome = yield* middleware.step(() => executeStep(at, scheduler))({
          sessionId: sessionId.toString(),
          turn,
          step,
          stepIndex: step,
        })
        const reachedLimit = step >= policy.maxTotalSteps || step >= policy.maxStepsPerTurn
        if (reachedLimit && outcome._tag === "ToolCalls") {
          return { _tag: "Stopped", stepCount: step } satisfies TurnOutcome
        }
        if (outcome._tag === "Stop" || reachedLimit) {
          return { _tag: "Completed", stepCount: step } satisfies TurnOutcome
        }
      }
    })

    const body = Effect.gen(function* () {
      const scheduler = yield* makeToolScheduler(policy.toolConcurrency)
      // A run is one user prompt, so it is one turn; `maxTurns` only gates it.
      if (policy.maxTurns < 1) return yield* emit({ _tag: "Finish", reason: "stopped" })
      const outcome = yield* middleware.turn(() => executeTurn(1, scheduler))({
        sessionId: sessionId.toString(),
        turn: 1,
        step: 0,
        stepCount: 0,
      })
      yield* emit({ _tag: "Finish", reason: outcome._tag === "Stopped" ? "stopped" : "completed" })
    })

    return body.pipe(
      Effect.catchCause((cause) =>
        emit({ _tag: "Finish", reason: "failed", message: Cause.pretty(cause).trim() }).pipe(
          Effect.andThen(Queue.failCause(queue, cause)),
        ),
      ),
      // A consumer dropping the stream interrupts this fiber directly; publish
      // Finish so subscribers waiting on it are released.
      Effect.onInterrupt(() => emit({ _tag: "Finish", reason: "interrupted" })),
      Effect.ensuring(Queue.end(queue)),
    )
  })
