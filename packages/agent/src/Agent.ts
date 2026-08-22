import { Effect } from "effect"

import type { AgentContext } from "./AgentContext.ts"
import { AgentPlan, type AgentPlan as AgentPlanValue } from "./AgentPlan.ts"
import type { Module } from "./Module.ts"

/** An explicit value that the runtime renders before each model request. */
export interface AgentDefinition<out R = never, out E = never> {
  readonly name: string
  readonly render: (context: AgentContext) => Effect.Effect<AgentPlanValue<R, E>, E, R>
}

export type AgentSource<R, E> =
  | Module<R, E>
  | ((context: AgentContext) => Effect.Effect<AgentPlanValue<R, E>, E, R>)

export const make = <R, E>(name: string, source: AgentSource<R, E>): AgentDefinition<R, E> => ({
  name,
  render:
    typeof source === "function"
      ? source
      : (context) =>
          source
            .build(context)
            .pipe(
              Effect.map(({ instructions, tools }) =>
                AgentPlan.make<R, E>({ instructions, tools }),
              ),
            ),
})

/** Namespace-style compatibility for `Agent.Agent.make`. */
export const Agent = { make }
