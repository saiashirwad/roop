import { Context, Crypto, Effect, Layer, Stream } from "effect"
import { Chat, type Toolkit } from "effect/unstable/ai"
import type * as Tool from "effect/unstable/ai/Tool"

import { AgentBus, AgentBusMemory, sessionEventsToAgentEvents } from "./AgentBus.ts"
import { AgentConfig, layer as agentConfigLayer } from "./AgentConfig.ts"
import type { AgentEvent, SessionEvent } from "./AgentEvents.ts"
import { AgentHooks } from "./AgentHooks.ts"
import { runLoop } from "./agentLoop.ts"
import { AgentTools } from "./AgentTools.ts"
import { capabilitiesFrom, type Capabilities } from "./Capabilities.ts"
import { SessionId, type ModelId } from "./DomainIds.ts"
import {
  ModelCatalog,
  type ModelNotFound,
  type ModelSpec,
  layer as modelCatalogLayer,
} from "./ModelCatalog.ts"
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
    readonly subscribe: (
      sessionId: SessionId | string,
      options?: { readonly replayFromStep?: number | undefined } | undefined,
    ) => Stream.Stream<AgentEvent, SessionNotFound | SessionFormatError | SessionIoError>
    readonly steer: (
      sessionId: SessionId | string,
      message: string,
    ) => Effect.Effect<void, RunNotFound>
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
  AgentConfig | AgentTools | ModelCatalog | Crypto.Crypto | SessionJournal | RunRegistry | AgentBus
> = Layer.effect(
  Agent,
  Effect.gen(function* () {
    const store = yield* SessionJournal
    const crypto = yield* Crypto.Crypto
    const runs = yield* RunRegistry
    const config = yield* AgentConfig
    const tools = yield* AgentTools
    const models = yield* ModelCatalog
    const hooks = yield* AgentHooks
    const bus = yield* AgentBus

    return Agent.of({
      capabilities: Effect.succeed(
        capabilitiesFrom({
          tools: tools.tools,
          models: models.ads,
          defaultModelId: models.defaultModelId,
          skills: config.skills,
        }),
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
            const model = yield* models.resolve(request.modelId)
            const systemPrompt = config.systemPrompt

            return runs.runStream(sessionId, (signal) =>
              Stream.unwrap(
                Effect.gen(function* () {
                  const append = (event: SessionEvent) =>
                    store
                      .append(sessionId, event)
                      .pipe(Effect.mapError((error) => runError(error, { sessionId })))

                  const stored = yield* store.load(sessionId).pipe(
                    Effect.asSome,
                    Effect.catchTag("SessionNotFound", () => Effect.succeedNone),
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
                      Effect.catchTag("SessionNotFound", () =>
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

                  return runLoop({
                    sessionId,
                    chat,
                    model,
                    toolkit: Effect.succeed(tools),
                    policy: request.policy,
                    interrupt: signal,
                    append,
                    hooks,
                  }).pipe(Stream.tap((event) => bus.publish({ sessionId, event })))
                }),
              ),
            )
          }),
        ),
      subscribe: (sessionId, options) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const sid = SessionId.make(sessionId)
            const session = yield* store.load(sid)
            const isActive = yield* runs.isActive(sid)

            const replayed = sessionEventsToAgentEvents(session.events, options?.replayFromStep)
            const pastStream = Stream.fromIterable(replayed)

            if (!isActive) {
              return pastStream
            }

            const liveStream = bus
              .subscribe(sid)
              .pipe(Stream.takeUntil((event) => event._tag === "Finish"))

            return Stream.concat(pastStream, liveStream)
          }),
        ),
      steer: (sessionId, message) => runs.steer(sessionId, message),
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
 * contributions. The toolkit's handlers stay caller-provided and the ambient
 * AgentHooks reference (default or caller-provided) is used directly.
 */
export const AgentLiveToolkit = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
  options?: {
    readonly systemPrompt?: string | undefined
    readonly models?: ReadonlyArray<ModelSpec<never, never>> | undefined
    readonly skills?: ReadonlyArray<Skill> | undefined
  },
): Layer.Layer<Agent, never, Crypto.Crypto | Tool.HandlersFor<Tools> | SessionJournal> => {
  const tools = Layer.effect(AgentTools, toolkit.pipe(Effect.map(eraseToolkit)))
  const config = agentConfigLayer({
    systemPrompt: options?.systemPrompt ?? "",
    skills: options?.skills ?? [],
  })

  return Layer.fresh(AgentLive).pipe(
    Layer.provide([
      tools,
      config,
      modelCatalogLayer(options?.models ?? []).pipe(Layer.orDie),
      RunRegistryLive,
      AgentBusMemory,
    ]),
    Layer.orDie,
  )
}
