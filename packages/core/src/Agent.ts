import { Context, Deferred, Effect, Layer, Stream } from "effect"
import { Toolkit } from "effect/unstable/ai"
import type * as Tool from "effect/unstable/ai/Tool"

import {
  capabilitiesFromMeta,
  type AgentCapabilities,
  type AgentMeta,
  type RunModelSettings,
} from "./AgentCapabilities.ts"
import type { AgentEvent } from "./AgentEvent.ts"
import { AgentRunner, RunNotFound, type StreamToolkit } from "./AgentRunner.ts"
import { ModelCatalog } from "./ModelCatalog.ts"
import { SessionLog } from "./SessionLog.ts"
import type { SessionRecord } from "./SessionStore.ts"

export type RunPromptOptions = {
  readonly prompt: string
  readonly sessionId?: string | undefined
  readonly modelId?: string | undefined
  readonly settings?: RunModelSettings | undefined
}

export { RunNotFound }

export class Agent extends Context.Service<
  Agent,
  {
    readonly runPrompt: (options: RunPromptOptions) => Stream.Stream<AgentEvent>
    readonly interrupt: (runId: string) => Effect.Effect<void, RunNotFound>
    readonly listCapabilities: () => Effect.Effect<AgentCapabilities>
  }
>()("roop/Agent") {}

const toolsFromToolkit = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
): AgentCapabilities["tools"] =>
  Object.values(toolkit.tools).map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
  }))

export const makeAgentLive = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
  meta: AgentMeta,
): Layer.Layer<Agent, never, ModelCatalog | Tool.HandlersFor<Tools> | SessionLog | AgentRunner> =>
  Effect.gen(function* () {
    const catalog = yield* ModelCatalog
    const handlers = (yield* toolkit) as unknown as StreamToolkit
    const log = yield* SessionLog
    const runner = yield* AgentRunner
    const toolCaps = toolsFromToolkit(toolkit)
    const capabilities = capabilitiesFromMeta(
      meta,
      toolCaps,
      catalog.available,
      catalog.defaultModelId,
    )

    return Agent.of({
      listCapabilities: () => Effect.succeed(capabilities),

      interrupt: (runId) => runner.interrupt(runId),

      runPrompt: (options) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const resolved = yield* Effect.result(
              catalog.resolve(options.modelId, options.settings),
            )

            if (resolved._tag === "Failure") {
              return Stream.make({
                _tag: "RunFailed" as const,
                message: `Unknown model: ${resolved.failure.modelId}`,
              }) as Stream.Stream<AgentEvent>
            }

            const modelService = resolved.success
            const runId = crypto.randomUUID()
            const interrupt = yield* Deferred.make<void>()
            yield* runner.registerRun(runId, interrupt)

            const clearRun = runner.clearRun(runId)

            const startOnSession = (
              sessionId: string,
              history: ReadonlyArray<SessionRecord>,
            ): Stream.Stream<AgentEvent> =>
              runner
                .runOnSession({
                  model: modelService,
                  toolkit: handlers,
                  sessionId,
                  history,
                  prompt: options.prompt,
                  runId,
                  interrupt,
                  systemPrompt: meta.systemPrompt,
                })
                .pipe(Stream.ensuring(clearRun))

            if (options.sessionId !== undefined) {
              return yield* log.get(options.sessionId).pipe(
                Effect.map((session) => startOnSession(session.id, session.records)),
                Effect.catchTag("SessionNotFound", (error) =>
                  Effect.gen(function* () {
                    yield* clearRun
                    return Stream.make({
                      _tag: "RunFailed" as const,
                      message: `Session not found: ${error.sessionId}`,
                    }) as Stream.Stream<AgentEvent>
                  }),
                ),
              )
            }

            const created = yield* log.create({ kind: "main" })
            return startOnSession(created.id, [])
          }),
        ),
    })
  }).pipe(Layer.effect(Agent))
