import { Effect, Layer } from "effect"
import { Toolkit } from "effect/unstable/ai"

import { Agent } from "./Agent.ts"
import { delegation } from "./agentTool.ts"
import { AgentPlugins, Plugin } from "./Plugin.ts"
import { SessionStoreMemory } from "./SessionStore.ts"

export const subagent = <R = never>(options: {
  readonly name: string
  readonly description: string
  readonly plugins: ReadonlyArray<Plugin<R>>
  readonly systemPrompt?: string | undefined
  readonly modelId?: string | undefined
  readonly maxTurns?: number | undefined
}): Plugin<R> => {
  const { tool, handler } = delegation(options)
  const toolkit = Toolkit.make(tool)
  const child = AgentPlugins(options.plugins, { systemPrompt: options.systemPrompt }).pipe(
    Layer.provide(SessionStoreMemory),
  )
  const handlers = toolkit
    .toLayer(
      Effect.gen(function* () {
        const agent = yield* Agent
        return { [options.name]: handler(agent) }
      }),
    )
    .pipe(Layer.provide(child))

  return Plugin({ name: options.name, toolkit, handlers })
}
