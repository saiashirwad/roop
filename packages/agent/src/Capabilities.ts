import { Schema } from "effect"
import { Tool } from "effect/unstable/ai"

import { ModelAd } from "./ModelCatalog.ts"
import { Skill } from "./Skills.ts"

export const ToolAd = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  parameters: Schema.Unknown,
})

export const Capabilities = Schema.Struct({
  tools: Schema.Array(ToolAd),
  models: Schema.Array(ModelAd),
  defaultModelId: Schema.String,
  skills: Schema.Array(Skill),
})

export type Capabilities = typeof Capabilities.Type
export type ToolAd = typeof ToolAd.Type

export const capabilitiesFrom = (options: {
  readonly tools: Record<string, Tool.Any>
  readonly models: ReadonlyArray<ModelAd>
  readonly defaultModelId: string
  readonly skills: ReadonlyArray<Skill>
}): Capabilities => ({
  tools: Object.values(options.tools).map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    parameters: Tool.getJsonSchema(tool),
  })),
  models: [...options.models],
  defaultModelId: options.defaultModelId,
  skills: [...options.skills],
})
