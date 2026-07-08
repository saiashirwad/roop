import type { Layer } from "effect"
import type { Toolkit } from "effect/unstable/ai"
import type * as Tool from "effect/unstable/ai/Tool"

export type PromptContribution = {
  readonly id: string
  readonly content: string
}

export type PluginToolSummary = {
  readonly name: string
  readonly description: string
}

export type PluginSummary = {
  readonly id: string
  readonly description: string
  readonly tools: ReadonlyArray<PluginToolSummary>
  readonly features?: ReadonlyArray<string>
}

export type Plugin<
  Tools extends Record<string, Tool.Any> = Record<string, never>,
  E = never,
  R = never,
> = {
  readonly id: string
  readonly description: string
  readonly toolkit: Toolkit.Toolkit<Tools>
  readonly handlers: Layer.Layer<Tool.HandlersFor<Tools>, E, R>
  readonly prompt: ReadonlyArray<PromptContribution>
  readonly features?: ReadonlyArray<string>
}

export const definePlugin = <Tools extends Record<string, Tool.Any>, E = never, R = never>(
  plugin: Plugin<Tools, E, R>,
): Plugin<Tools, E, R> => plugin

export const mergePromptContributions = (
  contributions: ReadonlyArray<PromptContribution>,
): string =>
  contributions
    .map((contribution) => contribution.content.trim())
    .filter((content) => content.length > 0)
    .join("\n\n")

export const collectPromptContributions = (
  plugins: ReadonlyArray<{ readonly prompt: ReadonlyArray<PromptContribution> }>,
): ReadonlyArray<PromptContribution> => plugins.flatMap((plugin) => plugin.prompt)

export const pluginSummaries = (
  plugins: ReadonlyArray<{
    readonly id: string
    readonly description: string
    readonly features?: ReadonlyArray<string> | undefined
    readonly toolkit: {
      readonly tools: Record<
        string,
        {
          readonly name: string
          readonly description?: string | undefined
        }
      >
    }
  }>,
): ReadonlyArray<PluginSummary> =>
  plugins.map((plugin) => ({
    id: plugin.id,
    description: plugin.description,
    tools: Object.values(plugin.toolkit.tools).map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
    })),
    ...(plugin.features !== undefined && plugin.features.length > 0
      ? { features: [...plugin.features] }
      : {}),
  }))
