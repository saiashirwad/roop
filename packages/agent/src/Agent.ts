import { Context, Deferred, Effect, Layer, Ref, Schema, Stream } from "effect"
import { Chat, Toolkit } from "effect/unstable/ai"
import type * as Tool from "effect/unstable/ai/Tool"

import { AgentEvent } from "./AgentEvent.ts"
import { runLoop, type ErasedToolkit } from "./agentLoop.ts"
import { capabilitiesFrom, type Capabilities } from "./Capabilities.ts"
import { ModelCatalog, ModelNotFound } from "./ModelCatalog.ts"
import { SessionNotFound, SessionStore, type Session } from "./SessionStore.ts"
import { Skills } from "./Skills.ts"

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
    readonly capabilities: () => Effect.Effect<Capabilities>
    readonly prompt: (
      options: PromptOptions,
    ) => Stream.Stream<AgentEvent, ModelNotFound | SessionBusy>
    readonly interrupt: (sessionId: string) => Effect.Effect<void, RunNotFound>
    readonly history: (sessionId: string) => Effect.Effect<Session, SessionNotFound>
  }
>()("roop/Agent") {}

export const AgentLive = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.WithHandler<Tools>,
  options?: { readonly systemPrompt?: string | undefined },
): Layer.Layer<Agent, never, ModelCatalog | SessionStore> =>
  Layer.effect(
    Agent,
    Effect.gen(function* () {
      const catalog = yield* ModelCatalog
      const store = yield* SessionStore
      const skillsOption = yield* Effect.serviceOption(Skills)
      const skills = skillsOption._tag === "Some" ? skillsOption.value.list : []
      const active = yield* Ref.make(new Map<string, Deferred.Deferred<void>>())
      const loop = toolkit as unknown as ErasedToolkit

      const systemPrompt = options?.systemPrompt ?? ""
      const seed = systemPrompt === "" ? [] : [{ role: "system" as const, content: systemPrompt }]

      const clearActive = (sessionId: string) =>
        Ref.update(active, (map) => {
          if (!map.has(sessionId)) return map
          const next = new Map(map)
          next.delete(sessionId)
          return next
        })

      return Agent.of({
        capabilities: () =>
          Effect.map(
            Effect.all([catalog.list(), catalog.defaultModelId()]),
            ([models, defaultModelId]) =>
              capabilitiesFrom({ tools: toolkit.tools, models, defaultModelId, skills }),
          ),
        prompt: (request) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const sessionId = request.sessionId ?? crypto.randomUUID()

              const stored = yield* Effect.option(store.load(sessionId))
              const messages = stored._tag === "Some" ? stored.value.messages : seed
              const chat = yield* Chat.fromPrompt([
                ...messages,
                {
                  role: "user" as const,
                  content: [{ type: "text" as const, text: request.prompt }],
                },
              ])
              const model = yield* catalog.resolve(request.modelId)

              const interrupt = yield* Deferred.make<void>()
              const claimed = yield* Ref.modify(active, (map) =>
                map.has(sessionId)
                  ? ([false, map] as const)
                  : ([true, new Map(map).set(sessionId, interrupt)] as const),
              )
              if (!claimed) {
                return yield* Effect.fail(new SessionBusy({ sessionId }))
              }

              const persist = () =>
                Effect.asVoid(
                  Ref.get(chat.history).pipe(
                    Effect.flatMap((history) => store.save(sessionId, history.content)),
                  ),
                )

              yield* persist()

              return runLoop({
                chat,
                model,
                toolkit: loop,
                maxTurns: request.maxTurns,
                interrupt,
                persist,
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
      })
    }),
  )

export const AgentLiveToolkit = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
  options?: { readonly systemPrompt?: string | undefined },
): Layer.Layer<Agent, never, Tool.HandlersFor<Tools> | ModelCatalog | SessionStore> =>
  Layer.unwrap(Effect.map(toolkit, (withHandler) => AgentLive(withHandler, options)))
