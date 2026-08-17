import { Schema } from "effect"
import { Tool } from "effect/unstable/ai"

import { ModelId } from "./DomainIds.ts"
import { ModelAd } from "./ModelCatalog.ts"
import { Skill } from "./Skills.ts"

const ToolAd = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  parameters: Schema.Unknown,
})

export const Capabilities = Schema.Struct({
  tools: Schema.Array(ToolAd),
  models: Schema.Array(ModelAd),
  defaultModelId: ModelId,
  skills: Schema.Array(Skill),
})

export type Capabilities = typeof Capabilities.Type

export const capabilitiesFrom = (options: {
  readonly tools: Record<string, Tool.Any>
  readonly models: ReadonlyArray<ModelAd>
  readonly defaultModelId: ModelId | string
  readonly skills: ReadonlyArray<Skill>
}): Capabilities => ({
  tools: Object.values(options.tools).map((tool) => ({
    name: tool.name,
    description: tool.description ?? "",
    parameters: Tool.getJsonSchema(tool),
  })),
  models: [...options.models],
  defaultModelId: ModelId.make(options.defaultModelId),
  skills: [...options.skills],
})
