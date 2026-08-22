/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-escape-hatch-assertions, anti-slop/require-safety-comment-for-type-assertion -- capability and module composition preserve typed effect channels across boundaries. */

import type { Effect } from "effect"

import type { AgentContext } from "./AgentContext.ts"
import {
  type AgentContribution,
  type Module,
  all as moduleAll,
  instructions as moduleInstructions,
} from "./Module.ts"

export interface Capability<out R = never, out E = never> {
  readonly name: string
  readonly module: Module<R, E>
  readonly build: (context: AgentContext) => Effect.Effect<AgentContribution<R, E>, E, R>
}

export type CapabilityElement<R, E> =
  | Capability<R, E>
  | Module<R, E>
  | { readonly module: Module<R, E> }
  | { readonly build: (context: AgentContext) => Effect.Effect<AgentContribution<R, E>, E, R> }

export interface CapabilityOptions<R = never, E = never> {
  readonly name: string
  readonly instructions?: string | undefined
  readonly tools?: ReadonlyArray<CapabilityElement<R, E>> | undefined
  readonly capabilities?: ReadonlyArray<CapabilityElement<R, E>> | undefined
}

const extractModule = <R, E>(element: CapabilityElement<R, E>): Module<R, E> => {
  if (
    "module" in element &&
    typeof element.module === "object" &&
    element.module !== null &&
    "build" in element.module
  ) {
    return element.module as Module<R, E>
  }
  return element as Module<R, E>
}

export function capability<R = never, E = never>(options: CapabilityOptions<R, E>): Capability<R, E>
export function capability<R = never, E = never>(
  name: string,
  module: Module<R, E>,
): Capability<R, E>
export function capability<R = never, E = never>(
  nameOrOptions: string | CapabilityOptions<R, E>,
  maybeModule?: Module<R, E>,
): Capability<R, E> {
  if (typeof nameOrOptions === "object" && nameOrOptions !== null) {
    const opts = nameOrOptions
    const modules: Array<Module<R, E>> = []
    if (opts.instructions !== undefined && opts.instructions.trim() !== "") {
      modules.push(moduleInstructions(opts.instructions) as Module<R, E>)
    }
    if (opts.tools !== undefined) {
      for (const t of opts.tools) {
        modules.push(extractModule(t))
      }
    }
    if (opts.capabilities !== undefined) {
      for (const c of opts.capabilities) {
        modules.push(extractModule(c))
      }
    }
    const combined = moduleAll(...modules) as Module<R, E>
    return {
      name: opts.name,
      module: combined,
      build: combined.build,
    }
  }

  const name = nameOrOptions
  const mod = maybeModule!
  return {
    name,
    module: mod,
    build: mod.build,
  }
}
