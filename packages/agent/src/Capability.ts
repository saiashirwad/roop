import { type Module, all as moduleAll, instructions as moduleInstructions } from "./Module.ts"

/** A named bundle of instructions and tools. It is itself a Module. */
export interface Capability<out R = never, out E = never> extends Module<R, E> {
  readonly name: string
  readonly module: Module<R, E>
}

/** Anything that contributes a Module: a Module, a Capability, or an AgentTool. */
export type CapabilityElement<R = any, E = any> = Module<R, E> | { readonly module: Module<R, E> }

export type Elements = ReadonlyArray<CapabilityElement>

/** The requirements of a list of elements, as the union of each element's R. */
export type ElementRequirements<T> = T extends { readonly module: Module<infer R, any> }
  ? R
  : T extends Module<infer R, any>
    ? R
    : never

export type ElementErrors<T> = T extends { readonly module: Module<any, infer E> }
  ? E
  : T extends Module<any, infer E>
    ? E
    : never

export interface CapabilityOptions<Tools extends Elements = [], Caps extends Elements = []> {
  readonly name: string
  readonly instructions?: string | undefined
  readonly tools?: Tools | undefined
  readonly capabilities?: Caps | undefined
}

const toModule = (element: CapabilityElement): Module<any, any> =>
  "module" in element ? element.module : element

export function capability<const Tools extends Elements = [], const Caps extends Elements = []>(
  options: CapabilityOptions<Tools, Caps>,
): Capability<
  ElementRequirements<Tools[number] | Caps[number]>,
  ElementErrors<Tools[number] | Caps[number]>
>
export function capability<R = never, E = never>(
  name: string,
  module: Module<R, E>,
): Capability<R, E>
export function capability(
  nameOrOptions: string | CapabilityOptions<Elements, Elements>,
  maybeModule?: Module<any, any>,
): Capability<any, any> {
  if (typeof nameOrOptions === "string") {
    const module = maybeModule!
    return { name: nameOrOptions, module, build: module.build }
  }
  const { name, instructions = "", tools = [], capabilities = [] } = nameOrOptions
  const module = moduleAll(
    moduleInstructions(instructions),
    ...tools.map(toModule),
    ...capabilities.map(toModule),
  )
  return { name, module, build: module.build }
}
