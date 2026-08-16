import { Context, Crypto, Effect, Layer, Scope } from "effect"
import { Toolkit } from "effect/unstable/ai"

import { Agent } from "./Agent.ts"
import { AgentContext } from "./AgentContext.ts"
import { delegation } from "./agentTool.ts"
import { AgentPlugins, Plugin, type PluginRequirements } from "./Plugin.ts"
import type { RunPolicy } from "./RunPolicy.ts"
import { SessionJournalMemory } from "./SessionJournal.ts"

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
  /* SAFETY: The dynamic handler generator provides the delegation tool implementation. */
  const handlers = toolkit.toLayer(
    Effect.gen(function* () {
      const ambientContext = yield* Effect.context<PluginRequirements<Plugins> | LayerIn>()
      const crypto = yield* Crypto.Crypto
      /* SAFETY: Omit parent AgentContext tag to isolate child agent context. */
      const context = ambientContext.pipe(Context.omit(AgentContext as any))
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
                      Effect.map((customCtx) => {
                        /* SAFETY: Omit parent AgentContext tag to isolate child agent context. */
                        const isolated = customCtx.pipe(Context.omit(AgentContext as any))
                        return Context.merge(context, isolated)
                      }),
                    )
                  : context
              const baseChild = makeChild(crypto)
              const childEnv = yield* Layer.buildWithScope(baseChild, scope).pipe(
                Effect.provide(childContext),
              )
              const agent = Context.get(childEnv, Agent)
              return yield* handler(agent)(params).pipe(Effect.provide(childContext))
            }),
          ),
      }
    }) as any,
  )

  /* SAFETY: The delegation subagent exposes the tool and requirements for child layers. */
  return Plugin({ name: options.name, toolkit, handlers }) as Plugin<
    PluginRequirements<Plugins> | LayerIn | Crypto.Crypto
  >
}
