import { Plugin } from "@roop/agent/Plugin.ts"
import * as CodexLanguageModel from "@texoport/effect-ai-codex"
import type { FileSystem, Path } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

export const Codex = (options?: {
  readonly models?: ReadonlyArray<{
    readonly id: string
    readonly description?: string | undefined
  }>
  readonly config?: Omit<CodexLanguageModel.Config, "model"> | undefined
}): Plugin<ChildProcessSpawner | FileSystem.FileSystem | Path.Path> => {
  const models = options?.models ?? [
    { id: "gpt-5-codex", description: "Codex via the local codex CLI" },
  ]

  return Plugin({
    name: "codex",
    models: models.map((model) => ({
      id: model.id,
      provider: "codex",
      description: model.description,
      layer: CodexLanguageModel.layer({ ...options?.config, model: model.id }),
    })),
  })
}
