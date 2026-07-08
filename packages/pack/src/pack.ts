/**
 * Default domain pack. Fork seam: edit `plugins` here (not server mains).
 * Models stay out of pack composition (see `model.ts`).
 */
import type { AgentMeta, SessionMeta, SubagentCapability } from "@roop/core/AgentCapabilities.ts"
import {
  collectPromptContributions,
  mergePromptContributions,
  pluginSummaries,
} from "@roop/core/Plugin.ts"
import { CorePlugin, GitPlugin, SubagentsPlugin } from "@roop/plugins/index.ts"
import { Layer } from "effect"
import { Toolkit } from "effect/unstable/ai"

import { exploreAgentSummary, PackAgentRegistryLive } from "./agents/registry.ts"

export { PackAgentRegistryLive }

export const packPlugins = [CorePlugin, GitPlugin, SubagentsPlugin] as const

export const PackToolkit = Toolkit.merge(
  Toolkit.merge(CorePlugin.toolkit, GitPlugin.toolkit),
  SubagentsPlugin.toolkit,
)

/** Host must provide fs/path/spawner + AgentRunner. */
export const PackToolsLive = Layer.mergeAll(
  CorePlugin.handlers,
  GitPlugin.handlers,
  SubagentsPlugin.handlers,
)

export const packSystemPrompt = mergePromptContributions(collectPromptContributions(packPlugins))

export const packPluginMeta = pluginSummaries(packPlugins)

export const packSubagents: ReadonlyArray<SubagentCapability> = [exploreAgentSummary]

const defaultSessionMeta: SessionMeta = {
  store: "jsonl",
  hub: "in-process",
  search: "from-store",
}

export const packAgentMeta = (session: SessionMeta = defaultSessionMeta): AgentMeta => ({
  systemPrompt: packSystemPrompt,
  plugins: packPluginMeta,
  session,
  agents: packSubagents,
})
