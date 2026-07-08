/**
 * Static model catalog. Live availability depends on env keys (see `model.ts`).
 * IDs are stable RPC handles: `provider/apiModel`.
 */

export type EffortSetting = {
  readonly levels: ReadonlyArray<string>
  readonly default: string
}

export type ThinkingSetting = {
  /** When false, thinking is always on for this model. */
  readonly canDisable: boolean
  readonly default: boolean
}

export type ModelDefinition = {
  /** Stable id: `provider/apiModel` (e.g. `kimi/k2p7`). */
  readonly id: string
  readonly provider: "kimi" | "zai" | "deepseek"
  readonly name: string
  /** Wire name sent to the provider API. */
  readonly apiModel: string
  readonly description?: string
  readonly effort?: EffortSetting
  readonly thinking?: ThinkingSetting
}

/** Kimi Coding Plan — OpenAI-compatible `https://api.kimi.com/coding/v1`. */
export const KIMI_MODELS: ReadonlyArray<ModelDefinition> = [
  {
    id: "kimi/k2p7",
    provider: "kimi",
    name: "K2.7 Code",
    apiModel: "k2p7",
    description: "Kimi Coding Plan — strongest coding model (K2.7 Code).",
    // Coding endpoint always thinks (`supports_thinking_type: only`).
    thinking: { canDisable: false, default: true },
  },
  {
    id: "kimi/k2p6",
    provider: "kimi",
    name: "K2.6",
    apiModel: "k2p6",
    description: "Kimi Coding Plan — general agent + coding (K2.6).",
    thinking: { canDisable: false, default: true },
  },
  {
    id: "kimi/k2p5",
    provider: "kimi",
    name: "K2.5",
    apiModel: "k2p5",
    description: "Kimi Coding Plan — multimodal coding (K2.5).",
    thinking: { canDisable: false, default: true },
  },
]

/** Z.AI Coding Plan — `https://api.z.ai/api/coding/paas/v4`. Effort on GLM-5.x when thinking is on. */
export const ZAI_MODELS: ReadonlyArray<ModelDefinition> = [
  {
    id: "zai/glm-5.2",
    provider: "zai",
    name: "GLM-5.2",
    apiModel: "glm-5.2",
    description: "Z.AI Coding Plan flagship — long-horizon coding (1M context).",
    effort: { levels: ["high", "max"], default: "high" },
    thinking: { canDisable: true, default: true },
  },
  {
    id: "zai/glm-5-turbo",
    provider: "zai",
    name: "GLM-5-Turbo",
    apiModel: "glm-5-turbo",
    description: "Z.AI Coding Plan — faster agent throughput.",
    effort: { levels: ["high", "max"], default: "high" },
    thinking: { canDisable: true, default: true },
  },
  {
    id: "zai/glm-5.1",
    provider: "zai",
    name: "GLM-5.1",
    apiModel: "glm-5.1",
    description: "Z.AI Coding Plan — previous flagship.",
    effort: { levels: ["high", "max"], default: "high" },
    thinking: { canDisable: true, default: true },
  },
  {
    id: "zai/glm-4.7",
    provider: "zai",
    name: "GLM-4.7",
    apiModel: "glm-4.7",
    description: "Z.AI Coding Plan — routine coding (lower quota cost).",
    thinking: { canDisable: true, default: true },
  },
]

/** DeepSeek API — OpenAI-compatible `https://api.deepseek.com`. */
export const DEEPSEEK_MODELS: ReadonlyArray<ModelDefinition> = [
  {
    id: "deepseek/deepseek-v4-pro",
    provider: "deepseek",
    name: "DeepSeek V4 Pro",
    apiModel: "deepseek-v4-pro",
    description: "DeepSeek flagship — strong reasoning + tools.",
    effort: { levels: ["high", "max"], default: "high" },
    thinking: { canDisable: true, default: true },
  },
  {
    id: "deepseek/deepseek-v4-flash",
    provider: "deepseek",
    name: "DeepSeek V4 Flash",
    apiModel: "deepseek-v4-flash",
    description: "DeepSeek — faster / cheaper V4.",
    effort: { levels: ["high", "max"], default: "high" },
    thinking: { canDisable: true, default: true },
  },
]

/** Preferred default when multiple providers have keys. */
export const DEFAULT_MODEL_PREFERENCE: ReadonlyArray<string> = [
  "kimi/k2p7",
  "zai/glm-5.2",
  "deepseek/deepseek-v4-pro",
]

export type ModelSettingsInput = {
  readonly effort?: string | undefined
  readonly thinking?: boolean | undefined
}

/** OpenAI-compat request extras (`reasoning_effort` / `thinking` for Z.AI and DeepSeek). */
export const requestConfigFor = (
  definition: ModelDefinition,
  settings?: ModelSettingsInput,
): Record<string, unknown> => {
  const config: Record<string, unknown> = {
    parallel_tool_calls: true,
  }

  if (definition.effort !== undefined) {
    const levels = definition.effort.levels
    const requested = settings?.effort
    const effort =
      requested !== undefined && levels.includes(requested) ? requested : definition.effort.default
    config.reasoning_effort = effort
  }

  if (definition.thinking !== undefined) {
    const enabled = definition.thinking.canDisable
      ? (settings?.thinking ?? definition.thinking.default)
      : true
    config.thinking = { type: enabled ? "enabled" : "disabled" }
  }

  return config
}
