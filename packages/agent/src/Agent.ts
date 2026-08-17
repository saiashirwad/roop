import { Context, Crypto, Effect, Layer, Option, Ref, Stream } from "effect"
import { Chat, Prompt, type Toolkit } from "effect/unstable/ai"
import type * as Tool from "effect/unstable/ai/Tool"

import { AgentContext, AgentContextLive, registerStatics } from "./AgentContext.ts"
import type { AgentEvent, SessionEvent } from "./AgentEvents.ts"
import { AgentHooks } from "./AgentHooks.ts"
import { runLoop } from "./agentLoop.ts"
import { capabilitiesFrom, type Capabilities } from "./Capabilities.ts"
import { SessionId, type ModelId } from "./DomainIds.ts"
import type { ModelNotFound, ModelSpec } from "./ModelCatalog.ts"
import { type RunError, runError } from "./RunError.ts"
import type { RunPolicy } from "./RunPolicy.ts"
import { type RunNotFound, RunRegistry, RunRegistryLive, type SessionBusy } from "./RunRegistry.ts"
import { eraseToolkit } from "./runStep.ts"
import {
  type SessionAlreadyExists,
  type SessionFormatError,
  SessionIoError,
  SessionJournal,
  type SessionNotFound,
  type Session,
  type SessionMeta,
} from "./SessionJournal.ts"
import type { Skill } from "./Skills.ts"

export { RunNotFound, SessionBusy } from "./RunRegistry.ts"

const findLastSystemMessage = (events: ReadonlyArray<SessionEvent>): string | undefined => {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event._tag === "system/message") return event.content
  }
  return undefined
}

export type PromptOptions = {
  readonly prompt: string
  readonly sessionId?: SessionId | string | undefined
  readonly modelId?: ModelId | string | undefined
  readonly policy?: RunPolicy | undefined
}

export class Agent extends Context.Service<
  Agent,
  {
    readonly capabilities: Effect.Effect<Capabilities>
    readonly prompt: (
      options: PromptOptions,
    ) => Stream.Stream<
      AgentEvent,
      ModelNotFound | SessionBusy | SessionFormatError | SessionIoError | RunError
    >
    readonly interrupt: (sessionId: SessionId | string) => Effect.Effect<void, RunNotFound>
    readonly history: (
      sessionId: SessionId | string,
    ) => Effect.Effect<Session, SessionNotFound | SessionFormatError | SessionIoError>
    readonly sessions: Effect.Effect<ReadonlyArray<SessionMeta>, SessionIoError>
    readonly fork: (
      fromSessionId: SessionId | string,
      toSessionId?: SessionId | string,
    ) => Effect.Effect<
      SessionMeta,
      SessionNotFound | SessionFormatError | SessionAlreadyExists | SessionIoError
    >
  }
>()("roop/Agent") {}

export const AgentLive: Layer.Layer<
  Agent,
  never,
  AgentContext | Crypto.Crypto | SessionJournal | RunRegistry
> = Layer.effect(
  Agent,
  Effect.gen(function* () {
    const store = yield* SessionJournal
    const crypto = yield* Crypto.Crypto
    const runs = yield* RunRegistry
    const context = yield* AgentContext

    return Agent.of({
      capabilities: Effect.map(
        Effect.all([context.tools, context.models, context.defaultModelId, context.skills]),
        ([tools, models, defaultModelId, skills]) =>
          capabilitiesFrom({ tools, models, defaultModelId, skills }),
      ),
      prompt: (request) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const sessionId =
              request.sessionId !== undefined
                ? SessionId.make(request.sessionId)
                : yield* Effect.orDie(
                    crypto.randomUUIDv4.pipe(Effect.map((id) => SessionId.make(id))),
                  )
            const model = yield* context.resolveModel(request.modelId)
            const systemPrompt = yield* context.systemPrompt

            return runs.runStream(sessionId, (signal) =>
              Stream.unwrap(
                Effect.gen(function* () {
                  const append = (event: SessionEvent) =>
                    store
                      .append(sessionId, event)
                      .pipe(Effect.mapError((error) => runError(error, { sessionId })))

                  const stored = yield* store.load(sessionId).pipe(
                    Effect.map((session) => Option.some<Session>(session)),
                    Effect.catchIf(
                      (error): error is SessionNotFound => error._tag === "SessionNotFound",
                      () => Effect.succeed(Option.none<Session>()),
                    ),
                  )

                  if (systemPrompt !== "") {
                    const lastSystem =
                      stored._tag === "Some"
                        ? findLastSystemMessage(stored.value.events)
                        : undefined
                    if (lastSystem !== systemPrompt) {
                      yield* append({ _tag: "system/message", content: systemPrompt })
                    }
                  }
                  yield* append({ _tag: "user/message", content: request.prompt })

                  const chat = yield* Chat.fromPrompt(
                    yield* store.deriveMessages(sessionId).pipe(
                      Effect.catchIf(
                        (error): error is SessionNotFound => error._tag === "SessionNotFound",
                        () =>
                          Effect.fail(
                            new SessionIoError({
                              operation: "deriveMessages",
                              sessionId,
                              message: `session ${sessionId} vanished after append`,
                            }),
                          ),
                      ),
                      Effect.mapError((error) => runError(error, { sessionId })),
                    ),
                  ).pipe(Effect.mapError((error) => runError(error, { sessionId })))

                  const journaledSections = new Set<string>()
                  if (systemPrompt !== "") journaledSections.add(systemPrompt)
                  for (const section of yield* context.promptSections)
                    journaledSections.add(section)

                  const hooks = yield* context.hooks

                  return runLoop({
                    sessionId,
                    chat,
                    model,
                    toolkit: context.toolkit,
                    beforeRequest: () =>
                      Effect.gen(function* () {
                        for (const section of yield* context.promptSections) {
                          if (journaledSections.has(section)) continue
                          journaledSections.add(section)
                          yield* append({ _tag: "system/message", content: section })
                          yield* Ref.update(chat.history, (history) =>
                            Prompt.concat(
                              history,
                              Prompt.make([{ role: "system", content: section }]),
                            ),
                          )
                        }
                      }),
                    policy: request.policy,
                    interrupt: signal,
                    append,
                    hooks,
                  })
                }),
              ),
            )
          }),
        ),
      interrupt: (sessionId) => runs.interrupt(sessionId),
      history: (sessionId) => store.load(SessionId.make(sessionId)),
      sessions: store.list,
      fork: (fromSessionId, toSessionId) =>
        Effect.gen(function* () {
          const fromId = SessionId.make(fromSessionId)
          const targetId =
            toSessionId !== undefined
              ? SessionId.make(toSessionId)
              : yield* Effect.orDie(
                  crypto.randomUUIDv4.pipe(Effect.map((id) => SessionId.make(id))),
                )
          return yield* store.fork(fromId, targetId)
        }),
    })
  }),
)

/**
 * Single-toolkit convenience: an agent from one toolkit plus optional static
 * contributions, registered through the same registry calls `AgentPlugins`
 * uses. Unlike `AgentPlugins` this installs no hook waterfall, so the ambient
 * `AgentHooks` (reference default, or a caller-provided layer) applies.
 * Tool handlers stay caller-provided.
 */
export const AgentLiveToolkit = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
  options?: {
    readonly systemPrompt?: string | undefined
    readonly models?: ReadonlyArray<ModelSpec<never, never>> | undefined
    readonly skills?: ReadonlyArray<Skill> | undefined
  },
): Layer.Layer<Agent, never, Crypto.Crypto | Tool.HandlersFor<Tools> | SessionJournal> => {
  const registry = Layer.unwrap(
    Effect.map(AgentHooks, (baseHooks) =>
      AgentContextLive(
        options?.systemPrompt === undefined
          ? { baseHooks }
          : { systemPrompt: options.systemPrompt, baseHooks },
      ),
    ),
  )

  const installToolkit = Layer.effectDiscard(
    Effect.gen(function* () {
      const context = yield* AgentContext
      const scope = yield* Effect.scope
      const handlersCtx = yield* Effect.context<Tool.HandlersFor<Tools>>()
      const withHandler = yield* Effect.provide(toolkit, handlersCtx)
      const erasedToolkit = eraseToolkit(withHandler)
      for (const tool of Object.values(withHandler.tools)) {
        /* SAFETY: Register each tool with its closed handlers into AgentContext. */
        yield* Effect.asVoid(context.registerTool(tool, erasedToolkit, { scope }))
      }
    }),
  )

  return AgentLive.pipe(
    Layer.provide([
      registry,
      RunRegistryLive,
      installToolkit.pipe(Layer.orDie, Layer.provide(registry)),
      registerStatics({
        models: options?.models ?? [],
        skills: options?.skills ?? [],
        conflictPolicy: "replace",
      }).pipe(Layer.provide(registry)),
    ]),
    Layer.orDie,
  )
}
