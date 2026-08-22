/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-escape-hatch-assertions, anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-unknown-parameters -- SAFETY: this module contains the single Journal JSON boundary and the typed Effect AI compatibility boundary. */

import { Cause, Context, Effect, Exit, Layer, Option, Ref, Stream } from "effect"
import { Chat, LanguageModel, Prompt, type AiError } from "effect/unstable/ai"

import type { AgentDefinition } from "./Agent.ts"
import type { AgentEvent, SessionEvent } from "./AgentEvents.ts"
import { makeRunId, makeSessionId, type RunId, type SessionId } from "./DomainIds.ts"
import { FinalizationError, type UnsafeModelRetry } from "./Error.ts"
import { EVENT_VERSION, type Json, type JournalEvent, type LifecycleState } from "./Event.ts"
import { fromEvents, recoveryEvents, toPrompt } from "./History.ts"
import { stableJsonValue } from "./internal/effectAiAdapter.ts"
import { run } from "./internal/run.ts"
import {
  Journal,
  type JournalAppendError,
  type JournalLoadError,
  type Revision,
} from "./Journal.ts"
import {
  all as allMiddleware,
  empty as emptyMiddleware,
  type Middleware,
  MiddlewareService,
} from "./Middleware.ts"
import type { RunError } from "./RunError.ts"
import type { RunPolicy } from "./RunPolicy.ts"
import { InterruptSignal } from "./RunSignal.ts"
import { ToolRegistry, type InvalidToolName, type ToolConflict } from "./ToolRegistry.ts"

/** Input for one direct, scoped kernel run. */
export interface AgentRuntimeRequest<out R = never, out E = never> {
  readonly sessionId: SessionId | string
  readonly runId?: RunId | string | undefined
  readonly prompt: string
  readonly policy?: RunPolicy | undefined
  readonly middleware?: Middleware<R, E> | undefined
}

export interface AgentRuntimeService {
  readonly run: <R, E, RM = never, EM = never>(
    agent: AgentDefinition<R, E>,
    request: AgentRuntimeRequest<RM, EM>,
  ) => Stream.Stream<
    AgentEvent,
    | E
    | EM
    | AiError.AiError
    | RunError
    | JournalLoadError
    | JournalAppendError
    | FinalizationError
    | InvalidToolName
    | ToolConflict
    | UnsafeModelRetry
    | Cause.TimeoutError,
    R | RM | LanguageModel.LanguageModel | Journal
  >
}

type RuntimeError<E> =
  | E
  | AiError.AiError
  | RunError
  | JournalLoadError
  | JournalAppendError
  | FinalizationError
  | InvalidToolName
  | ToolConflict
  | UnsafeModelRetry
  | Cause.TimeoutError

interface JournalBridge {
  readonly sessionId: SessionId
  readonly runId: RunId
  revision: Revision
  turn: number
  step: number
  attemptOpen: boolean
  attempt: number
}

const jsonValue = (value: unknown): Json => {
  /* SAFETY: stableJsonValue removes functions, symbols, undefined, and bigint. */
  return stableJsonValue(value) as Json
}

const terminalState = (reason: string): LifecycleState =>
  reason === "completed" ? "completed" : reason === "failed" ? "aborted" : "aborted"

const toDurableEvents = (
  bridge: JournalBridge,
  event: SessionEvent,
): ReadonlyArray<JournalEvent> => {
  const base = { version: EVENT_VERSION } as const
  switch (event._tag) {
    case "system/message":
      return [{ _tag: "system/message", ...base, content: event.content }]
    case "user/message":
      return [{ _tag: "user/message", ...base, content: event.content }]
    case "assistant/message":
      return [{ _tag: "assistant/message", ...base, parts: event.parts }]
    case "turn/start":
      bridge.turn += 1
      bridge.step = 0
      return [
        {
          _tag: "turn",
          ...base,
          runId: bridge.runId,
          turn: bridge.turn,
          state: "started",
        },
      ]
    case "turn/end":
      return [
        {
          _tag: "turn",
          ...base,
          runId: bridge.runId,
          turn: bridge.turn,
          state: terminalState(event.reason),
          reason: event.reason,
          ...(event.message === undefined ? undefined : { message: event.message }),
        },
      ]
    case "step/start":
      bridge.step += 1
      return [
        {
          _tag: "step",
          ...base,
          runId: bridge.runId,
          turn: bridge.turn,
          step: bridge.step,
          state: "started",
        },
      ]
    case "step/end": {
      const events: Array<JournalEvent> = []
      if (bridge.attemptOpen) {
        events.push({
          _tag: "model/attempt",
          ...base,
          runId: bridge.runId,
          turn: bridge.turn,
          step: bridge.step,
          attempt: bridge.attempt,
          requestId: `${bridge.runId}:${bridge.turn}:${bridge.step}`,
          state: terminalState(event.reason),
          ...(event.message === undefined ? undefined : { message: event.message }),
        })
        bridge.attemptOpen = false
      }
      events.push({
        _tag: "step",
        ...base,
        runId: bridge.runId,
        turn: bridge.turn,
        step: bridge.step,
        state: terminalState(event.reason),
        reason: event.reason,
        ...(event.message === undefined ? undefined : { message: event.message }),
      })
      return events
    }
    case "model/request": {
      const previousAttemptOpen = bridge.attemptOpen
      bridge.attemptOpen = true
      const requestId = `${bridge.runId}:${bridge.turn}:${bridge.step}`
      const request = jsonValue(event.request)
      const fingerprintValue =
        typeof event.request === "object" &&
        event.request !== null &&
        "fingerprint" in event.request
          ? (event.request as { readonly fingerprint?: unknown }).fingerprint
          : undefined
      const fingerprint =
        typeof fingerprintValue === "string"
          ? fingerprintValue
          : fingerprintValue === undefined
            ? ""
            : (JSON.stringify(fingerprintValue) ?? "")
      const toolNames =
        typeof event.request === "object" && event.request !== null && "toolNames" in event.request
          ? ((event.request as { readonly toolNames?: unknown }).toolNames ?? [])
          : []
      const attempt =
        typeof event.request === "object" && event.request !== null && "attempt" in event.request
          ? Number((event.request as { readonly attempt?: unknown }).attempt ?? 1)
          : 1
      const events: Array<JournalEvent> = []
      if (previousAttemptOpen) {
        events.push({
          _tag: "model/attempt",
          ...base,
          runId: bridge.runId,
          turn: bridge.turn,
          step: bridge.step,
          attempt: bridge.attempt,
          requestId,
          state: "aborted",
          message: "physical attempt ended before output",
        })
      }
      bridge.attempt = attempt
      events.push(
        {
          _tag: "model/attempt",
          ...base,
          runId: bridge.runId,
          turn: bridge.turn,
          step: bridge.step,
          attempt,
          requestId,
          state: "started",
        },
        {
          _tag: "model/request",
          ...base,
          runId: bridge.runId,
          turn: bridge.turn,
          step: bridge.step,
          requestId,
          request,
          planFingerprint: fingerprint,
          promptFingerprint: fingerprint,
          toolFingerprint: JSON.stringify(toolNames),
          toolNames: Array.isArray(toolNames) ? toolNames.map(String) : [],
        },
      )
      if (attempt > 1) events.splice(events.length - 1, 1)
      return events
    }
    case "tool/call":
      return [
        {
          _tag: "tool",
          ...base,
          runId: bridge.runId,
          turn: bridge.turn,
          step: bridge.step,
          id: event.id,
          name: event.name,
          state: "started",
        },
        {
          _tag: "tool/call",
          ...base,
          runId: bridge.runId,
          turn: bridge.turn,
          step: bridge.step,
          id: event.id,
          name: event.name,
          params: jsonValue(event.params),
          ...(event.providerExecuted === undefined
            ? undefined
            : { providerExecuted: event.providerExecuted }),
        },
      ]
    case "tool/result":
      return [
        {
          _tag: "tool/result",
          ...base,
          runId: bridge.runId,
          turn: bridge.turn,
          step: bridge.step,
          id: event.id,
          name: event.name,
          isFailure: event.isFailure,
          result: jsonValue(event.result),
          ...(event.providerExecuted === undefined
            ? undefined
            : { providerExecuted: event.providerExecuted }),
        },
        {
          _tag: "tool",
          ...base,
          runId: bridge.runId,
          turn: bridge.turn,
          step: bridge.step,
          id: event.id,
          name: event.name,
          state: event.isFailure ? "aborted" : "completed",
          isFailure: event.isFailure,
          result: jsonValue(event.result),
        },
      ]
  }
}

const runtimeRun = <R, E, RM = never, EM = never>(
  agent: AgentDefinition<R, E>,
  request: AgentRuntimeRequest<RM, EM>,
): Stream.Stream<
  AgentEvent,
  RuntimeError<E | EM>,
  R | RM | LanguageModel.LanguageModel | Journal
> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const model = yield* LanguageModel.LanguageModel
      const journal = yield* Journal
      const installedMiddleware = yield* Effect.serviceOption(MiddlewareService).pipe(
        Effect.map(Option.getOrElse(() => emptyMiddleware)),
      )
      const sessionId = makeSessionId(request.sessionId)
      const session = yield* journal.load(sessionId)
      const runId = makeRunId(request.runId ?? `${sessionId}:${session.revision}`)
      const bridge: JournalBridge = {
        sessionId,
        runId,
        revision: session.revision,
        turn: 0,
        step: 0,
        attemptOpen: false,
        attempt: 1,
      }
      const revisionRef = yield* Ref.make(session.revision)
      const recovery = recoveryEvents(session.events)
      if (recovery.length > 0) {
        const batch = [recovery[0]!, ...recovery.slice(1)] as readonly [
          JournalEvent,
          ...JournalEvent[],
        ]
        const nextRev = yield* journal.append(sessionId, session.revision, batch)
        yield* Ref.set(revisionRef, nextRev)
        bridge.revision = nextRev
      }
      const recoveredEvents = [...session.events, ...recovery]
      const history = toPrompt(fromEvents(recoveredEvents))
      const startEvents: JournalEvent[] = [
        {
          _tag: "user/message",
          version: EVENT_VERSION,
          content: request.prompt,
        },
        {
          _tag: "run",
          version: EVENT_VERSION,
          sessionId,
          runId,
          state: "started",
        },
      ]
      const currentRev = yield* Ref.get(revisionRef)
      const startedRev = yield* journal.append(
        sessionId,
        currentRev,
        startEvents as unknown as readonly [JournalEvent, ...JournalEvent[]],
      )
      yield* Ref.set(revisionRef, startedRev)
      bridge.revision = startedRev

      const chat = yield* Chat.fromPrompt(Prompt.concat(history, Prompt.make(request.prompt)))
      const append = Effect.fn("Runtime.append")(function* (event: SessionEvent) {
        const durable = toDurableEvents(bridge, event)
        if (durable.length === 0) return
        const batch = [durable[0]!, ...durable.slice(1)] as unknown as readonly [
          JournalEvent,
          ...JournalEvent[],
        ]
        const rev = yield* Ref.get(revisionRef)
        const nextRev = yield* journal.append(sessionId, rev, batch)
        yield* Ref.set(revisionRef, nextRev)
        bridge.revision = nextRev
      })
      const emptyToolkit = yield* ToolRegistry.empty.finalize
      // SAFETY: runtimeRun has already supplied the model and empty toolkit;
      // the explicit agent remains the only source of R and E at this boundary.
      const stream = run({
        sessionId,
        runId,
        agent,
        chat,
        model,
        toolkit: Effect.succeed(emptyToolkit.toolkit),
        policy: request.policy,
        // Direct runtime control is structured stream interruption. Host
        // supervisors interrupt the consumer fiber instead of passing a
        // request-scoped control signal through the kernel API.
        interrupt: InterruptSignal.noop(),
        append,
        /* SAFETY: runtimeRun restores the middleware R and E channels in its
         * public Stream type after the internal interpreter erasure. */
        middleware: allMiddleware(
          installedMiddleware,
          (request.middleware ?? emptyMiddleware) as Middleware,
        ),
      }) as Stream.Stream<AgentEvent, RuntimeError<E | EM>, R | RM>

      const terminalRef = yield* Ref.make(false)

      const appendRunState = Effect.fn("Runtime.appendRunState")(function* (
        state: LifecycleState,
        reason?: "completed" | "failed" | "interrupted" | "stopped",
      ) {
        const event: JournalEvent = {
          _tag: "run",
          version: EVENT_VERSION,
          sessionId,
          runId,
          state,
          ...(reason === undefined ? undefined : { reason }),
        }
        const batch = [event] as readonly [JournalEvent, ...JournalEvent[]]
        const rev = yield* Ref.get(revisionRef)
        const nextRev = yield* journal.append(sessionId, rev, batch)
        yield* Ref.set(revisionRef, nextRev)
        bridge.revision = nextRev
      })

      return stream.pipe(
        Stream.tap((event) =>
          event._tag === "Finish" && event.reason === "completed"
            ? Effect.gen(function* () {
                yield* Ref.set(terminalRef, true)
                yield* appendRunState("completed", "completed")
              })
            : Effect.void,
        ),
        Stream.catchCause((cause) =>
          Stream.unwrap(
            Effect.uninterruptible(
              Effect.gen(function* () {
                yield* Ref.set(terminalRef, true)
                return yield* Effect.exit(appendRunState("aborted", "failed"))
              }),
            ).pipe(
              Effect.flatMap((terminal) =>
                Exit.isSuccess(terminal)
                  ? Effect.failCause(cause)
                  : Effect.fail(
                      new FinalizationError({
                        sessionId,
                        primary: Option.getOrElse(Cause.findErrorOption(cause), () => cause),
                        journal: Option.getOrElse(
                          Cause.findErrorOption(terminal.cause),
                          () => terminal.cause,
                        ),
                      }),
                    ),
              ),
            ),
          ),
        ),
        Stream.ensuring(
          Effect.uninterruptible(
            Effect.flatMap(
              Ref.modify(terminalRef, (attempted) => (attempted ? [false, true] : [true, true])),
              (shouldRun) =>
                shouldRun
                  ? appendRunState("aborted", "interrupted").pipe(Effect.ignore)
                  : Effect.void,
            ),
          ),
        ),
      ) as unknown as Stream.Stream<AgentEvent, RuntimeError<E | EM>, R | RM | Journal>
    }),
  )

/** Effect capability for interpreting explicit Agent values. */
export class AgentRuntime extends Context.Service<AgentRuntime, AgentRuntimeService>()(
  "roop/AgentRuntime",
) {
  static readonly run = runtimeRun
}

/** A default capability layer for consumers that prefer service lookup. */
export const AgentRuntimeLive: Layer.Layer<AgentRuntime> = Layer.succeed(
  AgentRuntime,
  AgentRuntime.of({ run: runtimeRun }),
)

export const runAgent = runtimeRun
