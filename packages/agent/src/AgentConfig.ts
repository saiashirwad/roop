import { Context, Layer } from "effect"

import type { Skill } from "./Skills.ts"

/** Immutable metadata assembled while constructing an agent layer. */
export class AgentConfig extends Context.Service<
  AgentConfig,
  {
    readonly systemPrompt: string
    readonly skills: ReadonlyArray<Skill>
  }
>()("roop/AgentConfig") {}

export const layer = (config: AgentConfig["Service"]): Layer.Layer<AgentConfig> =>
  Layer.succeed(AgentConfig, config)
