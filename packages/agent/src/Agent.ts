import { Context, Crypto, Deferred, Effect, Layer, Option, Ref, Schema, Stream } from "effect"
import { Chat, Prompt, Toolkit } from "effect/unstable/ai"
import type * as Tool from "effect/unstable/ai/Tool"

import { AgentContext, AgentContextLive } from "./AgentContext.ts"
import { AgentEvent } from "./AgentEvent.ts"
import { AgentHooks } from "./AgentHooks.ts"
import { runLoop } from "./agentLoop.ts"
import { capabilitiesFrom, type Capabilities } from "./Capabilities.ts"
import { ModelCatalog, ModelNotFound } from "./ModelCatalog.ts"
import type { SessionEvent } from "./SessionEvent.ts"

const findLastSystemMessage = (events: ReadonlyArray<SessionEvent>): string | undefined => {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!
    if (event._tag === "system/message") return event.content
  }
  return undefined
}

import {
  SessionFormatError,
  SessionNotFound,
  SessionStore,
  type Session,
  type SessionMeta,
} from "./SessionStore.ts"

export class RunNotFound extends Schema.TaggedErrorClass<RunNotFound>()("RunNotFound", {
  sessionId: Schema.String,
}) {}

export class SessionBusy extends Schema.TaggedErrorClass<SessionBusy>()("SessionBusy", {
  sessionId: Schema.String,
}) {}

export type PromptOptions = {
  readonly prompt: string
  readonly sessionId?: string | undefined
  readonly modelId?: string | undefined
  readonly maxTurns?: number | undefined
}

export type AgentService = Agent["Service"]

export class Agent extends Context.Service<
  Agent,
  {
    readonly capabilities: Effect.Effect<Capabilities>
    readonly prompt: (
      options: PromptOptions,
    ) => Stream.Stream<AgentEvent, ModelNotFound | SessionBusy | SessionFormatError>
    readonly interrupt: (sessionId: string) => Effect.Effect<void, RunNotFound>
    readonly history: (
      sessionId: string,
    ) => Effect.Effect<Session, SessionNotFound | SessionFormatError>
    readonly sessions: Effect.Effect<ReadonlyArray<SessionMeta>>
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

      const clearActive = (sessionId: string) =>
        Ref.update(active, (map) => {
          if (!map.has(sessionId)) return map
          const next = new Map(map)
          next.delete(sessionId)
          return next
        })

      return Agent.of({
        capabilities:
          Effect.map(
            Effect.all([
              context.tools,
              context.models,
              context.defaultModelId,
              context.skills,
            ]),
            ([tools, models, defaultModelId, skills]) =>
              capabilitiesFrom({ tools, models, defaultModelId, skills }),
          ),
        prompt: (request) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const sessionId = request.sessionId ?? (yield* Effect.orDie(crypto.randomUUIDv4))
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

              const append = (event: SessionEvent) => store.append(sessionId, event)

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
                        Prompt.concat(history, Prompt.make([{ role: "system", content: section }])),
                      )
                    }
                  }),
                maxTurns: request.maxTurns,
                interrupt,
                append,
                hooks,
              }).pipe(Stream.ensuring(clearActive(sessionId)))
            }),
          ),
        interrupt: (sessionId) =>
          Ref.get(active).pipe(
            Effect.flatMap((map) => {
              const interrupt = map.get(sessionId)
              return interrupt === undefined
                ? Effect.fail(new RunNotFound({ sessionId }))
                : Effect.asVoid(Deferred.succeed(interrupt, undefined))
            }),
          ),
        history: (sessionId) => store.load(sessionId),
        sessions: store.list,
      })
    }),
  )

export const AgentLiveToolkit = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
  options?: { readonly systemPrompt?: string | undefined },
): Layer.Layer<
  Agent,
  never,
  Crypto.Crypto | Tool.HandlersFor<Tools> | ModelCatalog | SessionStore
> =>
  Layer.unwrap(
    Effect.map(toolkit, (withHandler) =>
      AgentLive(withHandler).pipe(Layer.provide(AgentContextLive(options))),
    ),
  )
