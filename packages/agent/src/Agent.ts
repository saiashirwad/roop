import { Context, Deferred, Effect, Layer, Ref, Schema, Stream } from "effect"
import { Chat, Toolkit } from "effect/unstable/ai"
import type * as Tool from "effect/unstable/ai/Tool"

import { AgentEvent } from "./AgentEvent.ts"
import { capabilitiesFrom, type Capabilities } from "./Capabilities.ts"
import { ModelCatalog, ModelNotFound } from "./ModelCatalog.ts"
import { runLoop } from "./agentLoop.ts"
import { SessionNotFound, SessionStore, type Session } from "./SessionStore.ts"
import { Skills } from "./Skills.ts"

export class RunNotFound extends Schema.TaggedErrorClass<RunNotFound>()("RunNotFound", {
  sessionId: Schema.String,
}) {}

export class SessionBusy extends Schema.TaggedErrorClass<SessionBusy>()("SessionBusy", {
  sessionId: Schema.String,
}) {}

export type StreamToolkit = Toolkit.WithHandler<Record<string, Tool.Any>>

export type PromptOptions = {
  readonly prompt: string
  readonly sessionId?: string | undefined
  readonly modelId?: string | undefined
}

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

export const AgentLive = (
  toolkit: StreamToolkit,
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

      const seed = (messages: ReadonlyArray<Session["messages"][number]>) =>
        messages.length > 0 || (options?.systemPrompt ?? "") === ""
          ? messages
          : [{ role: "system" as const, content: options?.systemPrompt ?? "" }]

      const clearActive = (sessionId: string) =>
        Ref.update(active, (map) => {
          map.delete(sessionId)
          return map
        })

      return Agent.of({
        capabilities: () =>
          Effect.map(
            Effect.all([catalog.list(), catalog.defaultModelId()]),
            ([models, defaultModelId]) =>
              capabilitiesFrom({ toolkit, models, defaultModelId, skills }),
          ),
        prompt: (request) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const sessionId = request.sessionId ?? crypto.randomUUID()
              const busy = yield* Ref.get(active).pipe(
                Effect.map((map) => map.has(sessionId)),
              )
              if (busy) {
                return yield* Effect.fail(new SessionBusy({ sessionId }))
              }

              const stored = yield* Effect.option(store.load(sessionId))
              const messages = stored._tag === "Some" ? stored.value.messages : seed([])
              const chat = yield* Chat.fromPrompt(messages)

              const interrupt = yield* Deferred.make<void>()
              yield* Ref.update(active, (map) => new Map(map).set(sessionId, interrupt))

              const model = yield* catalog.resolve(request.modelId)

              return runLoop({
                chat,
                model,
                toolkit,
                prompt: request.prompt,
                interrupt,
                onTurn: () =>
                  Effect.asVoid(
                    Ref.get(chat.history).pipe(
                      Effect.flatMap((history) => store.save(sessionId, history.content)),
                    ),
                  ),
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
): Layer.Layer<Agent, never, Tool.HandlersFor<Tools> | ModelCatalog | SessionStore> =>
  Layer.unwrap(
    Effect.map(toolkit, (withHandler) => AgentLive(withHandler as unknown as StreamToolkit)),
  )
