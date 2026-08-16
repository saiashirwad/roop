import { Context, Crypto, Deferred, Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import { Chat, Prompt, Toolkit } from "effect/unstable/ai"
import type * as Tool from "effect/unstable/ai/Tool"

import { AgentContext, AgentContextLive, registerStatics } from "./AgentContext.ts"
import { AgentEvent } from "./AgentEvent.ts"
import { AgentHooks } from "./AgentHooks.ts"
import { runLoop } from "./agentLoop.ts"
import { capabilitiesFrom, type Capabilities } from "./Capabilities.ts"
import { ModelNotFound, type ModelSpec } from "./ModelCatalog.ts"
import { ModelId } from "./ModelId.ts"
import type { RunPolicy } from "./RunPolicy.ts"
import type { SessionEvent } from "./SessionEvent.ts"
import { SessionId } from "./SessionId.ts"
import type { Skill } from "./Skills.ts"

const findLastSystemMessage = (events: ReadonlyArray<SessionEvent>): string | undefined => {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event._tag === "system/message") return event.content
  }
  return undefined
}

import {
  SessionAlreadyExists,
  SessionFormatError,
  SessionIoError,
  SessionNotFound,
  SessionStore,
  type Session,
  type SessionMeta,
} from "./SessionJournal.ts"

export class RunNotFound extends Schema.TaggedErrorClass<RunNotFound>()("RunNotFound", {
  sessionId: SessionId,
}) {}

export class SessionBusy extends Schema.TaggedErrorClass<SessionBusy>()("SessionBusy", {
  sessionId: SessionId,
}) {}

export type PromptOptions = {
  readonly prompt: string
  readonly sessionId?: SessionId | string | undefined
  readonly modelId?: ModelId | string | undefined
  /**
   * @deprecated Use `policy.maxTotalSteps` instead.
   */
  readonly maxTurns?: number | undefined
  readonly policy?: Partial<RunPolicy> | undefined
}

export class Agent extends Context.Service<
  Agent,
  {
    readonly capabilities: Effect.Effect<Capabilities>
    readonly prompt: (
      options: PromptOptions,
    ) => Stream.Stream<
      AgentEvent,
      ModelNotFound | SessionBusy | SessionFormatError | SessionIoError
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

export const AgentLive = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.WithHandler<Tools>,
): Layer.Layer<Agent, never, AgentContext | Crypto.Crypto | SessionStore> =>
  Layer.effect(
    Agent,
    Effect.gen(function* () {
      const store = yield* SessionStore
      const crypto = yield* Crypto.Crypto
      const hooks = yield* AgentHooks
      const active = yield* Ref.make(new Map<string, Deferred.Deferred<void>>())
      const context = yield* AgentContext
      yield* Effect.forEach(
        Object.values(toolkit.tools),
        /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
        (tool) => context.registerTool(tool, toolkit as any),
        {
          discard: true,
        },
      )

      const clearActive = (sessionId: string, run: Deferred.Deferred<void>) =>
        Ref.update(active, (map) => {
          if (map.get(sessionId) !== run) return map
          const next = new Map(map)
          next.delete(sessionId)
          return next
        })

      return Agent.of({
        capabilities: Effect.map(
          Effect.all([context.tools, context.models, context.defaultModelId, context.skills]),
          ([tools, models, defaultModelId, skills]) =>
            capabilitiesFrom({ tools, models, defaultModelId, skills }),
        ),
        prompt: (request) =>
          Stream.unwrap(
            // Assigned once the claim succeeds; setup failures use this same
            // token to release the claim before the stream is created.
            (() => {
              let cleanup: Effect.Effect<void> = Effect.void
              return Effect.gen(function* () {
                const sessionId =
                  request.sessionId !== undefined
                    ? SessionId.make(request.sessionId)
                    : yield* Effect.orDie(
                        crypto.randomUUIDv4.pipe(Effect.map((id) => SessionId.make(id))),
                      )
                const model = yield* context.resolveModel(request.modelId)
                const systemPrompt = yield* context.systemPrompt

                const interrupt = yield* Deferred.make<void>()
                const claimed = yield* Ref.modify(active, (map) =>
                  map.has(sessionId)
                    ? ([false, map] as const)
                    : ([true, new Map(map).set(sessionId, interrupt)] as const),
                )
                if (!claimed) {
                  return yield* new SessionBusy({ sessionId })
                }
                cleanup = clearActive(sessionId, interrupt)

                const append = (event: SessionEvent) =>
                  store.append(sessionId, event).pipe(Effect.orDie)

                const stored = yield* store.load(sessionId).pipe(
                  Effect.map((session) => Option.some<Session>(session)),
                  Effect.catchIf(
                    (error): error is SessionNotFound => error._tag === "SessionNotFound",
                    () => Effect.succeed(Option.none<Session>()),
                  ),
                )
                // An empty requested systemPrompt leaves the log untouched; a
                // non-empty one is appended whenever it diverges from the last
                // system message already recorded (including when there is none).
                if (systemPrompt !== "") {
                  const lastSystem =
                    stored._tag === "Some" ? findLastSystemMessage(stored.value.events) : undefined
                  if (lastSystem !== systemPrompt) {
                    yield* append({ _tag: "system/message", content: systemPrompt })
                  }
                }
                yield* append({ _tag: "user/message", content: request.prompt })

                const chat = yield* Effect.orDie(
                  Chat.fromPrompt(
                    yield* store.deriveMessages(sessionId).pipe(
                      // The log was just appended to, so a missing session here is
                      // impossible; treat it as a defect rather than widening the
                      // prompt error channel with SessionNotFound.
                      Effect.catchIf(
                        (error): error is SessionNotFound => error._tag === "SessionNotFound",
                        () => Effect.die(new Error(`session ${sessionId} vanished after append`)),
                      ),
                    ),
                  ),
                )

                const journaledSections = new Set<string>()
                if (systemPrompt !== "") journaledSections.add(systemPrompt)
                for (const section of yield* context.promptSections) journaledSections.add(section)

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
                  maxTurns: request.maxTurns,
                  policy: request.policy,
                  interrupt,
                  append,
                  hooks,
                }).pipe(Stream.ensuring(cleanup))
              }).pipe(
                // Claiming happens before any load/append/model setup. If that
                // setup fails, the stream never exists to run an ensuring finalizer.
                // Clear only this run's token so a later run cannot be disturbed.
                Effect.catchCause((cause) => cleanup.pipe(Effect.andThen(Effect.failCause(cause)))),
              )
            })(),
          ),
        interrupt: (sessionId) => {
          const sid = SessionId.make(sessionId)
          return Ref.get(active).pipe(
            Effect.flatMap((map) => {
              const interrupt = map.get(sid)
              return interrupt === undefined
                ? Effect.fail(new RunNotFound({ sessionId: sid }))
                : Effect.asVoid(Deferred.succeed(interrupt, undefined))
            }),
          )
        },
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
): Layer.Layer<Agent, never, Crypto.Crypto | Tool.HandlersFor<Tools> | SessionStore> => {
  const registry = AgentContextLive(
    options?.systemPrompt === undefined ? undefined : { systemPrompt: options.systemPrompt },
  )
  return Layer.unwrap(Effect.map(toolkit, (withHandler) => AgentLive(withHandler))).pipe(
    Layer.provide([
      registry,
      registerStatics({
        models: options?.models ?? [],
        skills: options?.skills ?? [],
      }).pipe(Layer.provide(registry)),
    ]),
  )
}
