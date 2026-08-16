import { Context, Effect, Layer, Scope } from "effect"
import { Toolkit } from "effect/unstable/ai"

import { Agent } from "./Agent.ts"
import { delegation } from "./agentTool.ts"
import { AgentPlugins, Plugin, type PluginRequirements } from "./Plugin.ts"
import { SessionStoreMemory } from "./SessionStore.ts"

export const subagent = <
  const Plugins extends ReadonlyArray<Plugin<any>>,
  LayerIn = never,
>(options: {
  readonly name: string
  readonly description: string
  readonly plugins: Plugins
  readonly systemPrompt?: string | undefined
  readonly modelId?: string | undefined
  readonly maxTurns?: number | undefined
  readonly layer?:
    | Layer.Layer<any, any, LayerIn>
    | ((params: { readonly task: string }) => Layer.Layer<any, any, LayerIn>)
    | undefined
}): Plugin<PluginRequirements<Plugins> | LayerIn> => {
  const { tool, handler } = delegation(options)
  const toolkit = Toolkit.make(tool)
  const makeChild = () =>
    AgentPlugins(options.plugins, { systemPrompt: options.systemPrompt }).pipe(
      Layer.provide(SessionStoreMemory),
    )
  const handlers = toolkit.toLayer(
    Effect.gen(function* () {
      const context = yield* Effect.context<PluginRequirements<Plugins> | LayerIn>()
      return {
        [options.name]: (params: { readonly task: string }) =>
          Effect.scoped(
            Effect.gen(function* () {
              const scope = yield* Scope.Scope
              const custom =
                typeof options.layer === "function" ? options.layer(params) : options.layer
              const contextLayer = Layer.succeedContext(context)
              const childContext =
                custom !== undefined
                  ? yield* Layer.buildWithScope(
                      custom as Layer.Layer<any, any, any>,
                      scope,
                    ).pipe(
                      Effect.provide(contextLayer),
                      Effect.map((customCtx) => Context.merge(context, customCtx)),
                    )
                  : context
              const baseChild = makeChild()
              const child = baseChild.pipe(Layer.provide(Layer.succeedContext(childContext)))
              const run = Effect.gen(function* () {
                const agent = yield* Agent
                return yield* handler(agent)(params)
              })
              return yield* run.pipe(
                Effect.provide(Layer.merge(child, Layer.succeedContext(childContext))),
              )
            }),
          ),
      }
    }),
  )

  return Plugin({ name: options.name, toolkit, handlers })
}
