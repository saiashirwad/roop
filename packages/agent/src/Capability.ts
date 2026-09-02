import { type Module, all as moduleAll, instructions as moduleInstructions } from "./Module.ts"

/** A named bundle of instructions and tools. It is itself a Module. */
export interface Capability<out R = never, out E = never> extends Module<R, E> {
  readonly name: string
  readonly module: Module<R, E>
}

/** Anything that contributes a Module: a Module, a Capability, or an AgentTool. */
export type CapabilityElement<R, E> = Module<R, E> | { readonly module: Module<R, E> }

export interface CapabilityOptions<R = never, E = never> {
  readonly name: string
  readonly instructions?: string | undefined
  readonly tools?: ReadonlyArray<CapabilityElement<R, E>> | undefined
  readonly capabilities?: ReadonlyArray<CapabilityElement<R, E>> | undefined
}

const toModule = <R, E>(element: CapabilityElement<R, E>): Module<R, E> =>
  "module" in element ? element.module : element

export function capability<R = never, E = never>(options: CapabilityOptions<R, E>): Capability<R, E>
export function capability<R = never, E = never>(
  name: string,
  module: Module<R, E>,
): Capability<R, E>
export function capability<R, E>(
  nameOrOptions: string | CapabilityOptions<R, E>,
  maybeModule?: Module<R, E>,
): Capability<R, E> {
  if (typeof nameOrOptions === "string") {
    const module = maybeModule!
    return { name: nameOrOptions, module, build: module.build }
  }
  const { name, instructions = "", tools = [], capabilities = [] } = nameOrOptions
  /* SAFETY: every element carries R and E; `all` re-states the union it collected. */
  const module = moduleAll(
    moduleInstructions(instructions),
    ...tools.map(toModule),
    ...capabilities.map(toModule),
  ) as Module<R, E>
  return { name, module, build: module.build }
}
