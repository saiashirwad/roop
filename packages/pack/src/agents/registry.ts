import type { SubagentCapability } from "@roop/core/AgentCapabilities.ts"
import { AgentNotFound, AgentRegistry } from "@roop/core/AgentRunner.ts"
import type { ResolvedAgentSpec } from "@roop/core/AgentSpec.ts"
import { fileSystemHandlers, ListFiles, ReadFile } from "@roop/tools/filesystem.ts"
import { Grep, grepHandlers } from "@roop/tools/grep.ts"
import { Effect, FileSystem, Layer, Path } from "effect"
import { Toolkit } from "effect/unstable/ai"

import { EXPLORE_DESCRIPTION, EXPLORE_SYSTEM_PROMPT } from "./explore.ts"

const ExploreToolkit = Toolkit.make(ReadFile, ListFiles, Grep)

export const exploreAgentSummary: SubagentCapability = {
  id: "explore",
  description: EXPLORE_DESCRIPTION,
  tools: Object.values(ExploreToolkit.tools).map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
  })),
}

/** Resolve pack subagent specs. Provide FileSystem + Path underneath. */
export const PackAgentRegistryLive = Layer.effect(
  AgentRegistry,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    // Only handlers that exist on ExploreToolkit — extra keys crash Toolkit.toLayer
    // (tools[name] is undefined → .id).
    const fsHandlers = fileSystemHandlers(fs, path)
    const exploreHandlers = ExploreToolkit.toLayer({
      readFile: fsHandlers.readFile,
      listFiles: fsHandlers.listFiles,
      ...grepHandlers(fs),
    })

    const exploreToolkit = yield* ExploreToolkit.pipe(Effect.provide(exploreHandlers))

    const explore: ResolvedAgentSpec = {
      id: exploreAgentSummary.id,
      description: exploreAgentSummary.description,
      systemPrompt: EXPLORE_SYSTEM_PROMPT,
      toolkit: exploreToolkit as unknown as ResolvedAgentSpec["toolkit"],
      maxTurns: 24,
    }

    const byId = new Map<string, ResolvedAgentSpec>([[explore.id, explore]])

    return AgentRegistry.of({
      list: () => [exploreAgentSummary],
      resolve: (agentId) => {
        const spec = byId.get(agentId)
        if (spec === undefined) {
          return Effect.fail(new AgentNotFound({ agentId }))
        }
        return Effect.succeed(spec)
      },
    })
  }),
)
