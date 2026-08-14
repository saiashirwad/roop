import { Layer } from "effect"
import { Toolkit } from "effect/unstable/ai"
import type * as Tool from "effect/unstable/ai/Tool"

import { AgentLiveToolkit, type Agent } from "./Agent.ts"
import { ModelCatalogLive, type ModelSpec } from "./ModelCatalog.ts"
import type { SessionStore } from "./SessionStore.ts"
import { Skills, type Skill } from "./Skills.ts"

export type Plugin<R = never> = {
  readonly name: string
  readonly toolkit?: Toolkit.Toolkit<Record<string, Tool.Any>> | undefined
  readonly handlers?: Layer.Layer<never, never, R> | undefined
  readonly models?: ReadonlyArray<ModelSpec<never, R>> | undefined
  readonly skills?: ReadonlyArray<Skill> | undefined
  readonly systemPrompt?: string | undefined
}

export const Plugin = <Tools extends Record<string, Tool.Any>, R = never>(options: {
  readonly name: string
  readonly toolkit?: Toolkit.Toolkit<Tools>
  readonly handlers?: Layer.Layer<Tool.HandlersFor<Tools>, never, R>
  readonly models?: ReadonlyArray<ModelSpec<never, R>>
  readonly skills?: ReadonlyArray<Skill>
  readonly systemPrompt?: string
}): Plugin<R> => options as unknown as Plugin<R>

type ErasedTools = Record<string, Tool.Any>

export const AgentPlugins = <R = never>(
  plugins: ReadonlyArray<Plugin<R>>,
  options?: { readonly systemPrompt?: string | undefined },
): Layer.Layer<Agent, never, SessionStore | R> => {
  const toolkit = Toolkit.merge(
    ...plugins.flatMap((plugin) => (plugin.toolkit === undefined ? [] : [plugin.toolkit])),
  ) as Toolkit.Toolkit<ErasedTools>
  const handlers = plugins.flatMap((plugin) =>
    plugin.handlers === undefined ? [] : [plugin.handlers],
  ) as unknown as ReadonlyArray<Layer.Layer<Tool.HandlersFor<ErasedTools>, never, R>>
  const models = plugins.flatMap((plugin) => plugin.models ?? [])
  const skills = plugins.flatMap((plugin) => plugin.skills ?? [])
  const systemPrompt = [options?.systemPrompt, ...plugins.map((plugin) => plugin.systemPrompt)]
    .filter((text): text is string => text !== undefined && text !== "")
    .join("\n\n")

  return AgentLiveToolkit(toolkit, { systemPrompt }).pipe(
    Layer.provide([ModelCatalogLive(models), Layer.succeed(Skills)({ list: skills }), ...handlers]),
  ) as Layer.Layer<Agent, never, SessionStore | R>
}
