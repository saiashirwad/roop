/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- existential child layers cross Toolkit's erased handler boundary. */
import { Context, Crypto, Effect, Layer, Schema, Scope, Stream } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"

import { Agent } from "./Agent.ts"
import { AgentContext } from "./AgentContext.ts"
import { AgentEmit, type AgentEvent } from "./AgentEvents.ts"
import { AgentPlugins, Plugin, type PluginRequirements } from "./Plugin.ts"
import type { RunError } from "./RunError.ts"
import type { RunPolicy } from "./RunPolicy.ts"
import { SessionJournalMemory } from "./SessionJournal.ts"

export class DelegationFailed extends Schema.TaggedErrorClass<DelegationFailed>()(
  "DelegationFailed",
  { message: Schema.String },
) {}

export type DelegationOptions = {
  readonly name: string
  readonly description: string
  readonly modelId?: string | undefined
  readonly policy?: RunPolicy | undefined
}
export const delegation = (options: DelegationOptions) => {
  const tool = Tool.make(options.name, {
    description: options.description,
    parameters: Schema.Struct({ task: Schema.String }),
    success: Schema.Struct({ summary: Schema.String }),
    failure: DelegationFailed,
    failureMode: "return",
  })

  const failureFor = (event: Extract<AgentEvent, { readonly _tag: "Finish" }>) => {
    switch (event.reason) {
      case "completed":
        return undefined
      case "failed":
        return new DelegationFailed({ message: event.message ?? "delegated agent failed" })
      case "interrupted":
        return new DelegationFailed({ message: "delegated agent was interrupted" })
      case "stopped":
        return new DelegationFailed({ message: "delegated agent hit its step/turn limit" })
    }
  }

  const handler = (agent: Agent["Service"]) => (params: { readonly task: string }) =>
    Effect.gen(function* () {
      const emit = yield* Effect.serviceOption(AgentEmit)
      let summary = ""
      let failure: DelegationFailed | undefined
      yield* Stream.runForEach(
        agent.prompt({ prompt: params.task, modelId: options.modelId, policy: options.policy }),
        (event) =>
          Effect.gen(function* () {
            if (emit._tag === "Some") {
              yield* emit.value.emit({
                _tag: "Subagent",
                name: options.name,
                ...(emit.value.toolCallId === undefined
                  ? undefined
                  : { toolCallId: emit.value.toolCallId }),
                event,
              })
            }
            if (event._tag === "TextDelta") summary += event.delta
            if (event._tag === "Finish") failure = failure ?? failureFor(event)
          }),
      ).pipe(
        Effect.catchTags({
          ModelNotFound: (error) =>
            new DelegationFailed({ message: `model not found: ${error.modelId}` }),
          SessionBusy: (error) =>
            new DelegationFailed({ message: `session busy: ${error.sessionId}` }),
          SessionFormatError: (error) =>
            new DelegationFailed({ message: `corrupt session log: ${error.message}` }),
          RunError: (error: RunError) =>
            new DelegationFailed({ message: `delegated agent ${error.operation} failed` }),
        }),
      )
      if (failure !== undefined) return yield* failure
      return { summary: summary.trim() || "(no output)" }
    })

  return { tool, handler }
}

export const subagent = <
  Plugins extends ReadonlyArray<Plugin<any, any, any>>,
  LayerIn = never,
>(options: {
  readonly name: string
  readonly description: string
  readonly plugins: Plugins
  readonly systemPrompt?: string | undefined
  readonly modelId?: string | undefined
  readonly policy?: RunPolicy | undefined
  readonly layer?:
    | Layer.Layer<any, any, LayerIn>
    | ((params: { readonly task: string }) => Layer.Layer<any, any, LayerIn>)
    | undefined
}): Plugin<PluginRequirements<Plugins> | LayerIn | Crypto.Crypto> => {
  const { tool, handler } = delegation(options)
  const toolkit = Toolkit.make(tool)
  const makeChild = (crypto: Crypto.Crypto) =>
    AgentPlugins(options.plugins, { systemPrompt: options.systemPrompt }).pipe(
      Layer.provide(SessionJournalMemory),
      Layer.provide(Layer.succeed(Crypto.Crypto, crypto)),
    )
  const handlers = toolkit.toLayer(
    Effect.gen(function* () {
      const ambientContext = yield* Effect.context<PluginRequirements<Plugins> | LayerIn>()
      const crypto = yield* Crypto.Crypto
      const context = ambientContext.pipe(
        Context.omit(
          /* SAFETY: child agents must not inherit the parent registry capability. */
          AgentContext as any,
        ),
      )
      return {
        [options.name]: (params: { readonly task: string }) =>
          Effect.scoped(
            Effect.gen(function* () {
              const scope = yield* Scope.Scope
              const custom = Layer.isLayer(options.layer) ? options.layer : options.layer?.(params)
              const contextLayer = Layer.succeedContext(context)
              const childContext =
                custom !== undefined
                  ? yield* Layer.buildWithScope(custom, scope).pipe(
                      Effect.provide(contextLayer),
                      Effect.map((customCtx) =>
                        Context.merge(
                          context,
                          customCtx.pipe(
                            Context.omit(
                              /* SAFETY: custom child layers are isolated from the parent registry too. */
                              AgentContext as any,
                            ),
                          ),
                        ),
                      ),
                    )
                  : context
              const childEnv = yield* Layer.buildWithScope(makeChild(crypto), scope).pipe(
                Effect.provide(childContext),
              )
              return yield* handler(Context.get(childEnv, Agent))(params).pipe(
                Effect.provide(childContext),
              )
            }),
          ),
      }
    }) /* SAFETY: existential requirements are closed by Toolkit.toLayer. */ as any,
  )
  /* SAFETY: the delegation toolkit exposes exactly the declared child requirements. */
  return Plugin({ name: options.name, toolkit, handlers }) as Plugin<
    PluginRequirements<Plugins> | LayerIn | Crypto.Crypto
  >
}
/* oxlint-enable anti-slop/require-safety-comment-for-type-assertion */
