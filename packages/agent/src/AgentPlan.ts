import { Prompt } from "effect/unstable/ai"

import type { InstructionFragment } from "./Module.ts"
import { ToolRegistry } from "./ToolRegistry.ts"

/** The model-facing instructions and tools for one logical request. */
export interface AgentPlan<out R = never, out E = never> {
  readonly instructions: ReadonlyArray<InstructionFragment>
  readonly tools: ToolRegistry<R, E>
}

export interface AgentPlanOptions<R = never, E = never> {
  readonly instructions?: ReadonlyArray<string | InstructionFragment> | undefined
  readonly tools?: ToolRegistry<R, E> | undefined
}

/** Build a plan while normalizing string instructions into named fragments. */
export const make = <R = never, E = never>(
  options: AgentPlanOptions<R, E> = {},
): AgentPlan<R, E> => ({
  instructions: (options.instructions ?? []).map((instruction, index) =>
    typeof instruction === "string"
      ? { text: instruction, contributor: `agent:${index + 1}` }
      : instruction,
  ),
  tools: options.tools ?? ToolRegistry.empty,
})

/** Compile ordered instruction fragments into the system prompt used by Effect AI. */
export const toPrompt = <R, E>(plan: AgentPlan<R, E>, prompt: Prompt.Prompt): Prompt.Prompt => {
  if (plan.instructions.length === 0) return prompt
  const system = Prompt.systemMessage({
    content: plan.instructions.map((item) => item.text).join("\n\n"),
  })
  return Prompt.fromMessages([system, ...prompt.content])
}

export const AgentPlan = Object.assign(make, { make, toPrompt })
