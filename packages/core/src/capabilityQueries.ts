import type { AgentCapabilities, PluginCapability } from "./AgentCapabilities.ts"

export const hasPlugin = (caps: AgentCapabilities | undefined, pluginId: string): boolean =>
  caps?.plugins.some((plugin) => plugin.id === pluginId) ?? false

export const hasFeature = (caps: AgentCapabilities | undefined, feature: string): boolean =>
  caps?.features.includes(feature) ?? false

export const hasTool = (caps: AgentCapabilities | undefined, toolName: string): boolean =>
  caps?.tools.some((tool) => tool.name === toolName) ?? false

export const pluginForTool = (
  caps: AgentCapabilities | undefined,
  toolName: string,
): PluginCapability | undefined =>
  caps?.plugins.find((plugin) => plugin.tools.some((tool) => tool.name === toolName))
