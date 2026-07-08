import { Cause, Context, Deferred, Effect, Layer, Option, Queue, Ref, Schema, Stream } from "effect"
import { Chat, LanguageModel, Toolkit, type Response } from "effect/unstable/ai"
import type * as Tool from "effect/unstable/ai/Tool"

import type { AgentEvent } from "./AgentEvent.ts"
import type { ResolvedAgentSpec } from "./AgentSpec.ts"
import { CurrentRun } from "./CurrentRun.ts"
import { promptFromSessionRecords } from "./sessionHistory.ts"
import { SessionLog } from "./SessionLog.ts"
import type { SessionNotFound, SessionRecord } from "./SessionStore.ts"

export class RunNotFound extends Schema.TaggedErrorClass<RunNotFound>()("RunNotFound", {
  runId: Schema.String,
}) {}

export class AgentNotFound extends Schema.TaggedErrorClass<AgentNotFound>()("AgentNotFound", {
  agentId: Schema.String,
}) {}

export class SpawnDepthExceeded extends Schema.TaggedErrorClass<SpawnDepthExceeded>()(
  "SpawnDepthExceeded",
  {
    depth: Schema.Number,
    max: Schema.Number,
  },
) {}

export class SpawnLimitExceeded extends Schema.TaggedErrorClass<SpawnLimitExceeded>()(
  "SpawnLimitExceeded",
  {
    count: Schema.Number,
    max: Schema.Number,
  },
) {}

const MAX_SPAWN_DEPTH = 3
const MAX_LIVE_CHILDREN = 8

export type StreamToolkit = Toolkit.WithHandler<Record<string, Tool.Any>>

type ActiveRun = {
  readonly interrupt: Deferred.Deferred<void>
  readonly parentRunId: string | undefined
  readonly children: Set<string>
}

type TurnOutcome =
  | {
      readonly _tag: "parts"
      readonly parts: ReadonlyArray<Response.StreamPart<Record<string, Tool.Any>>>
    }
  | { readonly _tag: "interrupted" }

export type RunOnSessionOptions = {
  readonly model: LanguageModel.Service
  readonly toolkit: StreamToolkit
  readonly sessionId: string
  readonly history: ReadonlyArray<SessionRecord>
  readonly prompt: string
  readonly runId: string
  readonly interrupt: Deferred.Deferred<void>
  readonly systemPrompt: string
  readonly maxTurns?: number | undefined
  readonly parentRunId?: string | undefined
  readonly depth?: number | undefined
}

export type SpawnAgentOptions = {
  readonly agentId: string
  readonly task: string
  readonly parentToolCallId: string
  readonly model: LanguageModel.Service
  readonly parentSessionId: string
  readonly parentRunId: string
  readonly reportProgress?:
    | ((result: {
        readonly status: "running"
        readonly childSessionId: string
        readonly childRunId: string
        readonly agentId: string
        readonly summary: string
      }) => Effect.Effect<void>)
    | undefined
}

export type SpawnAgentResult = {
  readonly status: "completed" | "failed" | "interrupted"
  readonly summary: string
  readonly childSessionId: string
  readonly childRunId: string
  readonly agentId: string
}

export type SpawnOptions = SpawnAgentOptions & {
  readonly sessionId?: string | undefined
  readonly depth?: number | undefined
}

/** Start is separate from await; `await` settles and never fails. */
export type RunHandle = {
  readonly runId: string
  readonly sessionId: string
  readonly agentId: string
  readonly await: Effect.Effect<SpawnAgentResult>
  readonly interrupt: Effect.Effect<void>
}

export type AgentRunnerService = {
  readonly registerRun: (
    runId: string,
    interrupt: Deferred.Deferred<void>,
    parentRunId?: string,
  ) => Effect.Effect<void>
  readonly clearRun: (runId: string) => Effect.Effect<void>
  readonly interrupt: (runId: string) => Effect.Effect<void, RunNotFound>
  readonly runOnSession: (options: RunOnSessionOptions) => Stream.Stream<AgentEvent>
  readonly spawn: (
    options: SpawnOptions,
  ) => Effect.Effect<
    RunHandle,
    AgentNotFound | SpawnDepthExceeded | SpawnLimitExceeded | SessionNotFound
  >
  readonly getRun: (runId: string) => Effect.Effect<Option.Option<RunHandle>>
}

export class AgentRunner extends Context.Service<AgentRunner, AgentRunnerService>()(
  "roop/AgentRunner",
) {}

export class AgentRegistry extends Context.Service<
  AgentRegistry,
  {
    readonly list: () => ReadonlyArray<{
      readonly id: string
      readonly description: string
      readonly tools: ReadonlyArray<{ readonly name: string; readonly description: string }>
    }>
    readonly resolve: (agentId: string) => Effect.Effect<ResolvedAgentSpec, AgentNotFound>
  }
>()("roop/AgentRegistry") {}

const fromStreamPart = (
  part: Response.StreamPart<Record<string, Tool.Any>>,
): AgentEvent | undefined => {
  switch (part.type) {
    case "reasoning-delta": {
      return { _tag: "ReasoningDelta", delta: part.delta }
    }
    case "text-delta": {
      return { _tag: "TextDelta", delta: part.delta }
    }
    case "tool-call": {
      return {
        _tag: "ToolCall",
        id: part.id,
        name: part.name,
        params: part.params,
      }
    }
    case "tool-result": {
      if (part.preliminary === true) {
        return {
          _tag: "ToolProgress",
          id: part.id,
          name: part.name,
          result: part.encodedResult,
        }
      }
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

const textFromEvents = (events: ReadonlyArray<AgentEvent>): string => {
  let text = ""
  for (const event of events) {
    if (event._tag === "TextDelta") {
      text += event.delta
    }
  }
  return text.trim()
}

const formatRunError = (cause: Cause.Cause<unknown>): string => {
  const pretty = Cause.pretty(cause).trim()
  if (pretty.length > 0) return pretty
  const squashed = Cause.squash(cause)
  if (typeof squashed === "string") return squashed
  if (squashed instanceof Error) return squashed.message || squashed.name
  return String(squashed)
}

/** Shared agent loop for parent runs and subagents. */
export const runPromptOnSession = (
  log: SessionLog["Service"],
  options: RunOnSessionOptions,
): Stream.Stream<AgentEvent> =>
  Stream.callback<AgentEvent>((queue) =>
    Effect.gen(function* () {
      const {
        model,
        toolkit,
        sessionId,
        history,
        prompt,
        runId,
        interrupt,
        systemPrompt,
        maxTurns,
      } = options

      const chat = yield* Chat.fromPrompt(promptFromSessionRecords(history, systemPrompt))

      yield* log.append(sessionId, { _tag: "UserPrompt", prompt })

      const offer = (event: AgentEvent) =>
        Effect.gen(function* () {
          yield* log.append(sessionId, { _tag: "Agent", event })
          yield* Queue.offer(queue, event)
        })

      yield* offer({
        _tag: "RunStarted",
        runId,
        sessionId,
      })

      let isFirstTurn = true
      let turns = 0

      while (true) {
        if (yield* Deferred.isDone(interrupt)) {
          yield* offer({ _tag: "RunInterrupted", runId })
          break
        }

        if (maxTurns !== undefined && turns >= maxTurns) {
          yield* offer({
            _tag: "RunFailed",
            message: `Subagent stopped: reached maxTurns (${maxTurns})`,
          })
          break
        }

        const streamWork = chat
          .streamText({
            prompt: isFirstTurn ? prompt : [],
            toolkit,
            concurrency: "unbounded",
          })
          .pipe(
            Stream.provideService(LanguageModel.LanguageModel, model),
            Stream.provideService(CurrentRun, {
              sessionId,
              runId,
              interrupt,
              model,
              depth: options.depth ?? 0,
            }),
            Stream.tap((part) => {
              const event = fromStreamPart(part)
              return event === undefined ? Effect.void : offer(event)
            }),
            Stream.runCollect,
            Effect.map(
              (parts): TurnOutcome => ({
                _tag: "parts",
                parts: [...parts],
              }),
            ),
          )

        const outcome = yield* Effect.raceFirst(
          streamWork,
          Deferred.await(interrupt).pipe(Effect.map((): TurnOutcome => ({ _tag: "interrupted" }))),
        )

        if (outcome._tag === "interrupted") {
          yield* offer({ _tag: "RunInterrupted", runId })
          break
        }

        isFirstTurn = false
        turns += 1

        if (!outcome.parts.some((part) => part.type === "tool-call")) {
          yield* offer({ _tag: "RunCompleted" })
          break
        }
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          // Cooperative interrupt already emitted RunInterrupted (or consumer cancelled).
          if (Cause.hasInterruptsOnly(cause)) {
            return
          }
          const event: AgentEvent = { _tag: "RunFailed", message: formatRunError(cause) }
          yield* log.append(options.sessionId, { _tag: "Agent", event }).pipe(Effect.ignore)
          yield* Queue.offer(queue, event)
        }),
      ),
      Effect.ensuring(Queue.end(queue)),
      Effect.orDie,
      Effect.asVoid,
    ),
  )

const cascadeInterrupt = (
  active: Map<string, ActiveRun>,
  runId: string,
  seen: Set<string>,
): Array<Deferred.Deferred<void>> => {
  if (seen.has(runId)) return []
  seen.add(runId)
  const entry = active.get(runId)
  if (entry === undefined) return []
  const deferreds = [entry.interrupt]
  for (const childId of entry.children) {
    deferreds.push(...cascadeInterrupt(active, childId, seen))
  }
  return deferreds
}

const succeedAll = (deferreds: ReadonlyArray<Deferred.Deferred<void>>) =>
  Effect.forEach(
    deferreds,
    (deferred) => Deferred.succeed(deferred, undefined).pipe(Effect.ignore),
    {
      discard: true,
    },
  )

export const AgentRunnerLive = Layer.effect(
  AgentRunner,
  Effect.gen(function* () {
    const log = yield* SessionLog
    const registry = yield* Effect.serviceOption(AgentRegistry)
    const activeRuns = yield* Ref.make(new Map<string, ActiveRun>())
    // Settled handles stay so getRun / await work after completion.
    const handles = yield* Ref.make(new Map<string, RunHandle>())

    // Merge-safe: re-register keeps existing children (interrupt tree).
    const registerRun = (runId: string, interrupt: Deferred.Deferred<void>, parentRunId?: string) =>
      Ref.update(activeRuns, (map) => {
        const next = new Map(map)
        const existing = next.get(runId)
        const resolvedParent = parentRunId ?? existing?.parentRunId
        next.set(runId, {
          interrupt,
          parentRunId: resolvedParent,
          children: existing?.children ?? new Set(),
        })
        if (resolvedParent !== undefined) {
          const parent = next.get(resolvedParent)
          if (parent !== undefined && !parent.children.has(runId)) {
            const children = new Set(parent.children)
            children.add(runId)
            next.set(resolvedParent, { ...parent, children })
          }
        }
        return next
      })

    // Drop from the tree; cascade-interrupt any remaining children.
    const clearRun = (runId: string) =>
      Effect.gen(function* () {
        const map = yield* Ref.get(activeRuns)
        const entry = map.get(runId)
        if (entry === undefined) {
          return
        }

        const orphanDeferreds: Array<Deferred.Deferred<void>> = []
        if (entry.children.size > 0) {
          for (const childId of entry.children) {
            orphanDeferreds.push(...cascadeInterrupt(map, childId, new Set([runId])))
          }
        }
        if (orphanDeferreds.length > 0) {
          yield* succeedAll(orphanDeferreds)
        }

        yield* Ref.update(activeRuns, (current) => {
          const latest = current.get(runId)
          const next = new Map(current)
          next.delete(runId)
          if (latest?.parentRunId !== undefined) {
            const parent = next.get(latest.parentRunId)
            if (parent !== undefined) {
              const children = new Set(parent.children)
              children.delete(runId)
              next.set(latest.parentRunId, { ...parent, children })
            }
          }
          return next
        })
      })

    const interruptCascade = (runId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const map = yield* Ref.get(activeRuns)
        yield* succeedAll(cascadeInterrupt(map, runId, new Set()))
      })

    const interrupt = (runId: string) =>
      Effect.gen(function* () {
        const map = yield* Ref.get(activeRuns)
        if (!map.has(runId)) {
          return yield* new RunNotFound({ runId })
        }
        yield* succeedAll(cascadeInterrupt(map, runId, new Set()))
      })

    const runOnSession = (options: RunOnSessionOptions): Stream.Stream<AgentEvent> =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* registerRun(options.runId, options.interrupt, options.parentRunId)
          return runPromptOnSession(log, options).pipe(Stream.ensuring(clearRun(options.runId)))
        }),
      )

    const spawn = (
      options: SpawnOptions,
    ): Effect.Effect<
      RunHandle,
      AgentNotFound | SpawnDepthExceeded | SpawnLimitExceeded | SessionNotFound
    > =>
      Effect.gen(function* () {
        const reg = Option.getOrUndefined(registry)
        if (reg === undefined) {
          return yield* new AgentNotFound({ agentId: options.agentId })
        }

        const depth = options.depth ?? 0
        if (depth >= MAX_SPAWN_DEPTH) {
          return yield* new SpawnDepthExceeded({ depth, max: MAX_SPAWN_DEPTH })
        }

        const liveChildren =
          (yield* Ref.get(activeRuns)).get(options.parentRunId)?.children.size ?? 0
        if (liveChildren >= MAX_LIVE_CHILDREN) {
          return yield* new SpawnLimitExceeded({ count: liveChildren, max: MAX_LIVE_CHILDREN })
        }

        const spec = yield* reg.resolve(options.agentId)

        const resumed =
          options.sessionId !== undefined ? yield* log.get(options.sessionId) : undefined
        const child =
          resumed ??
          (yield* log.create({
            parentSessionId: options.parentSessionId,
            kind: "subagent",
            agentId: spec.id,
            title: `${spec.id}: ${options.task.slice(0, 60)}`,
          }))
        const history = resumed?.records ?? []

        const childRunId = crypto.randomUUID()
        const childInterrupt = yield* Deferred.make<void>()
        yield* registerRun(childRunId, childInterrupt, options.parentRunId)

        yield* log
          .append(options.parentSessionId, {
            _tag: "Agent",
            event: {
              _tag: "SubagentStarted",
              parentToolCallId: options.parentToolCallId,
              agentId: spec.id,
              childSessionId: child.id,
              childRunId,
            },
          })
          .pipe(Effect.orDie)

        if (options.reportProgress !== undefined) {
          yield* options.reportProgress({
            status: "running",
            childSessionId: child.id,
            childRunId,
            agentId: spec.id,
            summary: "Subagent started",
          })
        }

        const settled = yield* Deferred.make<SpawnAgentResult>()

        const childStream = runOnSession({
          model: options.model,
          toolkit: spec.toolkit,
          sessionId: child.id,
          history,
          prompt: options.task,
          runId: childRunId,
          interrupt: childInterrupt,
          systemPrompt: spec.systemPrompt,
          maxTurns: spec.maxTurns,
          parentRunId: options.parentRunId,
          depth: depth + 1,
        })

        // Detached so the child outlives the tool handler; registry owns lifetime.
        yield* Effect.forkDetach(
          Effect.gen(function* () {
            const collected: Array<AgentEvent> = []

            yield* Stream.runForEach(childStream, (event) =>
              Effect.sync(() => {
                collected.push(event)
              }),
            ).pipe(Effect.ensuring(clearRun(childRunId)))

            const interrupted = collected.some((event) => event._tag === "RunInterrupted")
            const failed = collected.find((event) => event._tag === "RunFailed")
            const status: SpawnAgentResult["status"] = interrupted
              ? "interrupted"
              : failed !== undefined
                ? "failed"
                : "completed"

            const summary =
              status === "failed" && failed !== undefined && failed._tag === "RunFailed"
                ? failed.message
                : status === "interrupted"
                  ? "Subagent interrupted"
                  : textFromEvents(collected) || "(subagent finished with no text)"

            // Settlement must reach awaiters even if the parent session is gone.
            yield* log
              .append(options.parentSessionId, {
                _tag: "Agent",
                event: {
                  _tag: "SubagentCompleted",
                  parentToolCallId: options.parentToolCallId,
                  agentId: spec.id,
                  childSessionId: child.id,
                  childRunId,
                  status,
                },
              })
              .pipe(Effect.ignore)

            yield* Deferred.succeed(settled, {
              status,
              summary,
              childSessionId: child.id,
              childRunId,
              agentId: spec.id,
            })
          }),
        )

        const handle: RunHandle = {
          runId: childRunId,
          sessionId: child.id,
          agentId: spec.id,
          await: Deferred.await(settled),
          interrupt: interruptCascade(childRunId),
        }

        yield* Ref.update(handles, (map) => {
          const next = new Map(map)
          next.set(childRunId, handle)
          return next
        })

        return handle
      })

    const getRun = (runId: string): Effect.Effect<Option.Option<RunHandle>> =>
      Ref.get(handles).pipe(Effect.map((map) => Option.fromNullishOr(map.get(runId))))

    return AgentRunner.of({
      registerRun,
      clearRun,
      interrupt,
      runOnSession,
      spawn,
      getRun,
    })
  }),
)
