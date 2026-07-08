import { Schema } from "effect"

export const ToolCapabilitySchema = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
})

export const PluginCapabilitySchema = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  tools: Schema.Array(ToolCapabilitySchema),
  features: Schema.optionalKey(Schema.Array(Schema.String)),
})

export const SubagentCapabilitySchema = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  tools: Schema.Array(ToolCapabilitySchema),
})

export const EffortSettingSchema = Schema.Struct({
  levels: Schema.Array(Schema.String),
  default: Schema.String,
})

export const ThinkingSettingSchema = Schema.Struct({
  canDisable: Schema.Boolean,
  default: Schema.Boolean,
})

export const ModelSettingsSchema = Schema.Struct({
  effort: Schema.optionalKey(EffortSettingSchema),
  thinking: Schema.optionalKey(ThinkingSettingSchema),
})

export const ModelOptionSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  provider: Schema.String,
  description: Schema.optionalKey(Schema.String),
  settings: ModelSettingsSchema,
})

/** Wired runtime surface — metadata only, for client UI gating. */
export const AgentCapabilitiesSchema = Schema.Struct({
  models: Schema.Array(ModelOptionSchema),
  defaultModelId: Schema.String,
  tools: Schema.Array(ToolCapabilitySchema),
  plugins: Schema.Array(PluginCapabilitySchema),
  agents: Schema.Array(SubagentCapabilitySchema),
  sessionStore: Schema.String,
  sessionHub: Schema.String,
  sessionSearch: Schema.String,
  features: Schema.Array(Schema.String),
})

export type AgentCapabilities = typeof AgentCapabilitiesSchema.Type
export type PluginCapability = typeof PluginCapabilitySchema.Type
export type SubagentCapability = typeof SubagentCapabilitySchema.Type
export type ToolCapability = typeof ToolCapabilitySchema.Type
export type ModelOption = typeof ModelOptionSchema.Type

export const RunModelSettingsSchema = Schema.Struct({
  effort: Schema.optionalKey(Schema.String),
  thinking: Schema.optionalKey(Schema.Boolean),
})

export type RunModelSettings = typeof RunModelSettingsSchema.Type

export type SessionMeta = {
  readonly store: string
  readonly hub: string
  readonly search: string
}

export type AgentMeta = {
  readonly systemPrompt: string
  readonly plugins: ReadonlyArray<PluginCapability>
  readonly session: SessionMeta
  readonly agents?: ReadonlyArray<SubagentCapability> | undefined
}

/** Feature flags from wired tools/plugins/backends (`none` = not provided). */
export const deriveFeatures = (input: {
  readonly tools: ReadonlyArray<ToolCapability>
  readonly plugins: ReadonlyArray<PluginCapability>
  readonly session: SessionMeta
  readonly models?: ReadonlyArray<ModelOption>
  readonly agents?: ReadonlyArray<SubagentCapability>
}): ReadonlyArray<string> => {
  const features: Array<string> = ["sessions", "interrupt"]
  if (input.tools.length > 0) {
    features.push("tools")
  }
  if (input.plugins.length > 0) {
    features.push("plugins")
  }
  if (input.session.search !== "none") {
    features.push("search")
  }
  if (input.session.hub !== "none") {
    features.push("subscribe")
  }
  if (input.models !== undefined && input.models.length > 0) {
    features.push("models")
  }
  if (input.agents !== undefined && input.agents.length > 0) {
    features.push("subagents")
  }
  return features
}

export const capabilitiesFromMeta = (
  meta: AgentMeta,
  tools: ReadonlyArray<ToolCapability>,
  models: ReadonlyArray<ModelOption>,
  defaultModelId: string,
): AgentCapabilities => {
  const agents = meta.agents ?? []

  return {
    models: [...models],
    defaultModelId,
    tools,
    plugins: meta.plugins,
    agents: [...agents],
    sessionStore: meta.session.store,
    sessionHub: meta.session.hub,
    sessionSearch: meta.session.search,
    features: [
      ...deriveFeatures({
        tools,
        plugins: meta.plugins,
        session: meta.session,
        models,
        agents,
      }),
    ],
  }
}
