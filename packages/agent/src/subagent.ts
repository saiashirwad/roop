import { Effect, Layer } from "effect"
import { Toolkit } from "effect/unstable/ai"

import { Agent } from "./Agent.ts"
import { delegation } from "./agentTool.ts"
import { AgentPlugins, Plugin, type PluginRequirements } from "./Plugin.ts"
import { SessionStoreMemory } from "./SessionStore.ts"

export const subagent = <const Plugins extends ReadonlyArray<Plugin<any>>>(options: {
  readonly name: string
  readonly description: string
  readonly plugins: Plugins
  readonly systemPrompt?: string | undefined
  readonly modelId?: string | undefined
  readonly maxTurns?: number | undefined
}): Plugin<PluginRequirements<Plugins>> => {
  const { tool, handler } = delegation(options)
  const toolkit = Toolkit.make(tool)
  const child = AgentPlugins(options.plugins, { systemPrompt: options.systemPrompt }).pipe(
    Layer.provide(SessionStoreMemory),
  )
  const handlers = toolkit.toLayer(
    Effect.gen(function* () {
      const context = yield* Effect.context<PluginRequirements<Plugins>>()
      return {
        [options.name]: (params: { readonly task: string }) =>
          Effect.scoped(
            Effect.gen(function* () {
              const agent = yield* Agent
              return yield* handler(agent)(params)
            }).pipe(Effect.provide(child), Effect.provide(context)),
          ),
      }
    }),
  )

  return Plugin({ name: options.name, toolkit, handlers })
}
