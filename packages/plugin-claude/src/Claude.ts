import { Plugin } from "@roop/agent/Plugin.ts"
import * as ClaudeLanguageModel from "@texoport/effect-ai-claude"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

export const Claude = (options?: {
  readonly models?: ReadonlyArray<{
    readonly id: string
    readonly description?: string | undefined
  }>
  readonly config?: Omit<ClaudeLanguageModel.Config, "model"> | undefined
}): Plugin<ChildProcessSpawner> => {
  const models = options?.models ?? [
    { id: "sonnet", description: "Claude Sonnet via the local claude CLI" },
  ]

  return Plugin({
    name: "claude",
    models: models.map((model) => ({
      id: model.id,
      provider: "claude",
      ...(model.description !== undefined ? { description: model.description } : {}),
      layer: ClaudeLanguageModel.layer({ ...options?.config, model: model.id }),
    })),
  })
}
