/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-escape-hatch-assertions -- the intercepted toolkit is the one place the interpreter re-enters the Effect AI handler existential. */

import { Cause, Duration, Effect, Exit, Option, Ref, type Scope, Stream } from "effect"
import { Prompt, type AiError, type LanguageModel, type Response } from "effect/unstable/ai"
import type * as Tool from "effect/unstable/ai/Tool"

import type { AgentDefinition } from "../Agent.ts"
import { toPrompt as planToPrompt } from "../AgentPlan.ts"
import type { RunId, SessionId } from "../DomainIds.ts"
import { ModelTimeout, UnsafeModelRetry } from "../Error.ts"
import {
  addUsage,
  emptyUsage,
  EVENT_VERSION,
  type FinishReason,
  type Json,
  type JournalEvent,
  type LifecycleState,
  type ModelAttemptEvent,
  type ModelFinishReason,
  type Unstamped,
  type Usage,
} from "../Event.ts"
import { Inbox, type InboxMessage, type RunInbox } from "../Inbox.ts"
import type { JournalAppendError } from "../Journal.ts"
import type { Middleware, ModelCallInput, ToolCallInput } from "../Middleware.ts"
import { RunEmit, type RunEmitService, type UnstampedLiveEvent } from "../RunEvent.ts"
import type { ResolvedRunPolicy } from "../RunPolicy.ts"
import { make as makeTasks, Tasks, type TasksService } from "../Tasks.ts"
import { ToolExecutionContext, type ToolExecutionContextService } from "../ToolExecutionContext.ts"
import type { FinalizedToolkit, InvalidToolName, ToolConflict } from "../ToolRegistry.ts"
import {
  planFingerprint,
  requestFingerprint,
  streamModel,
  toJson,
  toolDescriptors,
  toolFingerprint,
  usageFromResponse,
} from "./effectAiAdapter.ts"
import { makeToolCallCorrelator } from "./toolCallCorrelator.ts"
import { makeToolScheduler, type ToolScheduler } from "./toolScheduler.ts"

/** Commit semantic events to the journal and publish them live. An empty batch is a no-op. */
export type AppendEvents = (
  events: ReadonlyArray<Unstamped<JournalEvent>>,
) => Effect.Effect<void, JournalAppendError>

/** Publish one live-only event. */
export type EmitEvent = (event: UnstampedLiveEvent) => Effect.Effect<void>

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
  readonly emit: EmitEvent
  /** Messages delivered to the run while it executes; drained at step boundaries. */
  readonly inbox: RunInbox
}

export type RunStreamError<E> =
  | E
  | AiError.AiError
  | JournalAppendError
  | InvalidToolName
  | ToolConflict
  | UnsafeModelRetry
  | ModelTimeout

/** How the run's turn ended: `stopped` when a step limit cut off pending tool calls. */
export type RunOutcome = "completed" | "stopped"

type Part = Response.StreamPart<Record<string, Tool.Any>>

type StepOutcome =
  | { readonly _tag: "Stop" }
  | { readonly _tag: "ToolCalls"; readonly toolCallCount: number }

type TurnOutcome = { readonly _tag: "Completed" | "Stopped"; readonly stepCount: number }

/** What the provider reported at the end of one physical attempt. */
interface AttemptFinish {
  readonly usage: Usage
  readonly finishReason: ModelFinishReason
}

/** Attempt bookkeeping for one step. `open` is the attempt the journal has not closed yet. */
interface AttemptState {
  readonly active: boolean
  readonly outputObserved: boolean
  readonly toolDispatchStarted: boolean
  readonly open: Option.Option<number>
  /** The open attempt's finish part, once observed. */
  readonly finish: Option.Option<AttemptFinish>
  /** The model that answered the open attempt, when the provider names it. */
  readonly model: Option.Option<string>
  /** Usage summed over every attempt of this step that reported it. */
  readonly usage: Usage
}

const initialAttemptState: AttemptState = {
  active: false,
  outputObserved: false,
  toolDispatchStarted: false,
  open: Option.none(),
  finish: Option.none(),
  model: Option.none(),
  usage: emptyUsage,
}

interface StepLocation {
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

const stepStarted = (where: StepLocation): Unstamped<JournalEvent> => ({
  _tag: "step",
  ...V,
  ...where,
  state: "started",
})

const stepEnded = (
  where: StepLocation,
  outcome: SpanOutcome,
  usage: Usage,
): Unstamped<JournalEvent> => ({
  _tag: "step",
  ...V,
  ...where,
  state: terminalState(outcome.reason),
  reason: outcome.reason,
  ...withMessage(outcome.message),
  usage,
})

const requestId = (where: StepLocation) => `${where.runId}:${where.turn}:${where.step}`

const attemptEvent = (
  where: StepLocation,
  attempt: number,
  state: LifecycleState,
  message?: string,
): Unstamped<ModelAttemptEvent> => ({
  _tag: "model/attempt",
  ...V,
  ...where,
  attempt,
  requestId: requestId(where),
  state,
  ...withMessage(message),
})

/** Close the open attempt with whatever the provider reported for it. */
const attemptEnded = (
  where: StepLocation,
  attempt: number,
  outcome: SpanOutcome,
  state: AttemptState,
): Unstamped<ModelAttemptEvent> => ({
  ...attemptEvent(where, attempt, terminalState(outcome.reason), outcome.message),
  ...Option.match(state.finish, {
    onNone: () => undefined,
    onSome: (finish) => ({ usage: finish.usage, finishReason: finish.finishReason }),
  }),
  ...Option.match(state.model, { onNone: () => undefined, onSome: (model) => ({ model }) }),
})

const toolCallEvents = (
  where: StepLocation,
  call: { readonly id: string; readonly name: string; readonly params: unknown },
  providerExecuted: boolean,
): ReadonlyArray<Unstamped<JournalEvent>> => [
  { _tag: "tool", ...V, ...where, id: call.id, name: call.name, state: "started" },
  {
    _tag: "tool/call",
    ...V,
    ...where,
    id: call.id,
    name: call.name,
    params: toJson(call.params),
    providerExecuted,
  },
]

const toolResultEvents = (
  where: StepLocation,
  result: { readonly id: string; readonly name: string; readonly isFailure: boolean },
  encoded: Json,
  providerExecuted: boolean,
): ReadonlyArray<Unstamped<JournalEvent>> => [
  {
    _tag: "tool/result",
    ...V,
    ...where,
    id: result.id,
    name: result.name,
    isFailure: result.isFailure,
    result: encoded,
    providerExecuted,
  },
  {
    _tag: "tool",
    ...V,
    ...where,
    id: result.id,
    name: result.name,
    state: result.isFailure ? "aborted" : "completed",
    isFailure: result.isFailure,
    result: encoded,
  },
]

/** The complete assistant messages of one model response. Token deltas are live-only. */
const assistantMessageEvents = (response: Prompt.Prompt): ReadonlyArray<Unstamped<JournalEvent>> =>
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
 * Executes a run: one turn of model steps over one agent, with journal spans
 * and tool interception. Journal events reach the consumer through `append`
 * and live-only events through `emit`; the caller owns the `run` span.
 */
export const run = <R, E>(
  options: RunOptions<R, E>,
): Effect.Effect<RunOutcome, RunStreamError<E>, R | Scope.Scope> => {
  const { agent, append, emit, inbox, middleware, policy, runId, sessionId } = options

  /** One model request plus the tool calls it produces. */
  const executeStep = Effect.fn("run.executeStep")(function* (
    where: StepLocation,
    scheduler: ToolScheduler,
    tasks: TasksService,
  ) {
    const attempts = yield* Ref.make<AttemptState>(initialAttemptState)
    yield* append([stepStarted(where)])
    return yield* stepBody(where, attempts, scheduler, tasks).pipe(
      Effect.scoped,
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          const outcome = exitOutcome(exit, () => "completed")
          const state = yield* Ref.get(attempts)
          yield* append([
            ...Option.toArray(
              Option.map(state.open, (attempt) => attemptEnded(where, attempt, outcome, state)),
            ),
            stepEnded(where, outcome, state.usage),
          ])
        }),
      ),
    )
  })

  const stepBody = Effect.fn("run.stepBody")(function* (
    where: StepLocation,
    attempts: Ref.Ref<AttemptState>,
    scheduler: ToolScheduler,
    tasks: TasksService,
  ) {
    const { turn, step } = where
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
    ) => append(toolCallEvents(where, call, providerExecuted))

    const recordToolResult = (
      result: {
        readonly id: string
        readonly name: string
        readonly isFailure: boolean
        readonly result: unknown
      },
      providerExecuted: boolean,
    ) => append(toolResultEvents(where, result, toJson(result.result), providerExecuted))

    const toolOutput = (id: string, name: string, output: Json) =>
      emit({ _tag: "tool/output", ...V, runId, step, id, name, output })

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
        const emitService: RunEmitService = {
          output: (output) => toolOutput(id, name, output),
          subagent: (childName, event) =>
            emit({ _tag: "subagent", ...V, name: childName, toolCallId: id, event }),
        }
        const scheduled = (input: ToolCallInput) =>
          scheduler.scheduleEffect(
            finalized.toolkit.handle(input.name, input.params).pipe(
              Effect.map((stream) =>
                stream.pipe(
                  Stream.provideService(ToolExecutionContext, executionContext),
                  Stream.provideService(RunEmit, emitService),
                  Stream.provideService(Tasks, tasks),
                  Stream.provideService(Inbox, inbox),
                ),
              ),
              Effect.provideService(ToolExecutionContext, executionContext),
              Effect.provideService(RunEmit, emitService),
              Effect.provideService(Tasks, tasks),
              Effect.provideService(Inbox, inbox),
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
              ? toolOutput(id, name, toJson(result.encodedResult))
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
          finish: Option.none(),
          model: Option.none(),
        }))
        const events: Array<Unstamped<JournalEvent>> = Option.toArray(
          Option.map(previous.open, (attempt) =>
            attemptEvent(where, attempt, "aborted", "physical attempt ended before output"),
          ),
        )
        events.push(attemptEvent(where, input.attempt, "started"))
        // A retry replays the same logical request; only the first attempt records it.
        if (input.attempt === 1) {
          const prompt = toJson(input.prompt)
          const promptFp = JSON.stringify(prompt)
          events.push({
            _tag: "model/request",
            ...V,
            ...where,
            requestId: requestId(where),
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
            return yield* emit({ _tag: "text/delta", ...V, runId, step, delta: part.delta })
          case "reasoning-delta":
            return yield* emit({ _tag: "reasoning/delta", ...V, runId, step, delta: part.delta })
          case "response-metadata": {
            const modelId = part.modelId
            if (modelId === undefined) return
            return yield* Ref.update(attempts, (state) => ({
              ...state,
              model: Option.some(modelId),
            }))
          }
          case "finish": {
            const finish: AttemptFinish = {
              usage: usageFromResponse(part.usage),
              finishReason: part.reason,
            }
            return yield* Ref.update(attempts, (state) => ({
              ...state,
              finish: Option.some(finish),
              usage: addUsage(state.usage, finish.usage),
            }))
          }
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
            if (!part.providerExecuted) return
            const id = Option.getOrElse(correlator.tokenForProviderId(part.id), () => part.id)
            if (part.preliminary)
              return yield* toolOutput(id, part.name, toJson(part.encodedResult))
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
    tasks: TasksService,
  ) {
    const where = { runId, turn }
    yield* append([{ _tag: "turn", ...V, ...where, state: "started" }])
    return yield* turnBody(turn, scheduler, tasks).pipe(
      Effect.onExit((exit) => {
        const outcome = exitOutcome(exit, (value: TurnOutcome) =>
          value._tag === "Stopped" ? "stopped" : "completed",
        )
        return append([
          {
            _tag: "turn",
            ...V,
            ...where,
            state: terminalState(outcome.reason),
            reason: outcome.reason,
            ...withMessage(outcome.message),
          },
        ])
      }),
    )
  })

  /**
   * Commit messages that arrived during the last step. They follow that
   * step's tool results in the journal and in the model-visible history, so
   * the next request sees them exactly where the user sent them.
   */
  const deliver = (messages: ReadonlyArray<InboxMessage>) =>
    Effect.gen(function* () {
      if (messages.length === 0) return
      yield* Ref.update(options.history, (history) =>
        messages.reduce((prompt, message) => Prompt.concat(prompt, message.content), history),
      )
      yield* append(
        messages.map((message) => ({ _tag: "user/message", ...V, content: message.content })),
      )
    })

  const turnBody = Effect.fn("run.turnBody")(function* (
    turn: number,
    scheduler: ToolScheduler,
    tasks: TasksService,
  ) {
    let step = 0
    while (true) {
      step += 1
      const where: StepLocation = { runId, turn, step }
      const outcome: StepOutcome = yield* middleware.step(() =>
        executeStep(where, scheduler, tasks),
      )({
        sessionId: sessionId.toString(),
        turn,
        step,
        stepIndex: step,
      })
      const reachedLimit = step >= policy.maxTotalSteps || step >= policy.maxStepsPerTurn
      // The inbox is drained only where another step can follow. At the step
      // limit the inbox closes now, so a later `send` fails with `RunEnded`
      // instead of being accepted and dropped; what it still held is committed
      // so the next run's prompt starts with it. A final answer closes the
      // inbox in the same atomic step that finds it empty: a message that
      // arrived while the model was answering keeps the run going instead.
      const messages = yield* reachedLimit
        ? inbox.close
        : outcome._tag === "ToolCalls"
          ? inbox.takeAll
          : inbox.takeAllOrClose
      yield* deliver(messages)
      if (reachedLimit) {
        return outcome._tag === "ToolCalls"
          ? ({ _tag: "Stopped", stepCount: step } satisfies TurnOutcome)
          : ({ _tag: "Completed", stepCount: step } satisfies TurnOutcome)
      }
      if (outcome._tag === "Stop" && messages.length === 0) {
        return { _tag: "Completed", stepCount: step } satisfies TurnOutcome
      }
    }
  })

  return Effect.gen(function* () {
    const scheduler = yield* makeToolScheduler(policy.toolConcurrency)
    // Background tasks live in the run's scope: unfinished ones are
    // interrupted when the run ends.
    const tasks = yield* makeTasks(yield* Effect.scope)
    // A run is one user prompt, so it is one turn; `maxTurns` only gates it.
    if (policy.maxTurns < 1) return "stopped" as const
    const outcome = yield* middleware.turn(() => executeTurn(1, scheduler, tasks))({
      sessionId: sessionId.toString(),
      turn: 1,
      step: 0,
      stepCount: 0,
    })
    return outcome._tag === "Stopped" ? ("stopped" as const) : ("completed" as const)
  })
}
