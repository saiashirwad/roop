/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-escape-hatch-assertions, anti-slop/require-safety-comment-for-type-assertion -- module composition re-states the typed channels it collected over an existential list. */

import { Effect, type Context, type Layer } from "effect"
import type * as Tool from "effect/unstable/ai/Tool"
import * as Toolkit from "effect/unstable/ai/Toolkit"

import type { AgentContext } from "./AgentContext.ts"
import { ToolRegistry } from "./ToolRegistry.ts"

export interface InstructionFragment {
  readonly text: string
  readonly contributor: string
}

export interface AgentContribution<out R = never, out E = never> {
  readonly instructions: ReadonlyArray<InstructionFragment>
  readonly tools: ToolRegistry<R, E>
}

/** The kernel's composition unit: a context-aware contribution of instructions and tools. */
export interface Module<out R = never, out E = never> {
  readonly build: (context: AgentContext) => Effect.Effect<AgentContribution<R, E>, E, R>
}

export type Requirements<M> = M extends Module<infer R, infer _E> ? R : never
export type Errors<M> = M extends Module<infer _R, infer E> ? E : never

const contribution = <R, E>(
  instructions: ReadonlyArray<InstructionFragment>,
  tools: ToolRegistry<R, E>,
): AgentContribution<R, E> => ({ instructions, tools })

const make = <R, E>(
  build: (context: AgentContext) => Effect.Effect<AgentContribution<R, E>, E, R>,
): Module<R, E> => ({ build })

export const empty: Module = make(() => Effect.succeed(contribution([], ToolRegistry.empty)))

export const instructions = (text: string, contributor = text): Module =>
  make(() =>
    Effect.succeed(
      contribution(text.trim() === "" ? [] : [{ text, contributor }], ToolRegistry.empty),
    ),
  )

export type ToolHandler<T extends Tool.Any> = (
  params: Tool.Parameters<T>,
  context: Toolkit.HandlerContext<T>,
) => Effect.Effect<Tool.Success<T>, Tool.Failure<T>, Tool.HandlerServices<T>>

export function tool<const T extends Tool.Any, E, R>(
  definition: T,
  handler: (
    params: Tool.Parameters<T>,
    context: Toolkit.HandlerContext<T>,
  ) => Effect.Effect<Tool.Success<T>, E, R>,
  contributor?: string,
): Module<R | Tool.HandlerServices<T>, E> {
  const toolkit = Toolkit.make(definition)
  // SAFETY: Toolkit.toLayer checks the tool definition and this existential
  // boundary is removed again by ToolRegistry.finalize.
  const handlers = toolkit.toLayer({ [definition.name]: handler } as never)
  return make(() =>
    Effect.succeed(
      contribution(
        [],
        ToolRegistry.fromContribution<R | Tool.HandlerServices<T>, E>({
          tool: definition,
          contributor: contributor ?? definition.name,
          toolkit,
          handlers,
        }),
      ),
    ),
  )
}

/** Combine modules in declaration order. Instructions concatenate; tools must not collide. */
export const all = <const Modules extends ReadonlyArray<Module<any, any>>>(
  ...modules: Modules
): Module<Requirements<Modules[number]>, Errors<Modules[number]>> =>
  make((context) =>
    Effect.forEach(modules, (module) => module.build(context)).pipe(
      Effect.map((parts) =>
        contribution(
          parts.flatMap((part) => part.instructions),
          ToolRegistry.combine(...parts.map((part) => part.tools)),
        ),
      ),
    ),
  ) as Module<Requirements<Modules[number]>, Errors<Modules[number]>>

export function when<M extends Module<any, any>>(
  condition: boolean | ((context: AgentContext) => boolean),
  module: M,
): Module<Requirements<M>, Errors<M>>
export function when<M extends Module<any, any>, R, E>(
  condition: Effect.Effect<boolean, E, R>,
  module: M,
): Module<Requirements<M> | R, Errors<M> | E>
export function when<M extends Module<any, any>, R, E>(
  condition: (context: AgentContext) => Effect.Effect<boolean, E, R>,
  module: M,
): Module<Requirements<M> | R, Errors<M> | E>
export function when<M extends Module<any, any>, R, E>(
  condition:
    | boolean
    | Effect.Effect<boolean, E, R>
    | ((context: AgentContext) => boolean | Effect.Effect<boolean, E, R>),
  module: M,
): Module<Requirements<M> | R, Errors<M> | E> {
  return make((context) => {
    const selected = typeof condition === "function" ? condition(context) : condition
    const decision = typeof selected === "boolean" ? Effect.succeed(selected) : selected
    return decision.pipe(
      Effect.flatMap((enabled) => (enabled ? module.build(context) : empty.build(context))),
    )
  })
}

/** Rewrite a module's tool handlers and its own build with the same provision. */
const mapTools = (
  module: Module<any, any>,
  f: (registry: ToolRegistry<any, any>) => ToolRegistry<any, any>,
  provide: (effect: Effect.Effect<any, any, any>) => Effect.Effect<any, any, any>,
): Module<any, any> =>
  make((context) =>
    provide(
      module
        .build(context)
        .pipe(Effect.map((part) => contribution(part.instructions, f(part.tools)))),
    ),
  )

export const provide = <M extends Module<any, any>, I, S>(
  module: M,
  service: Context.Key<I, S>,
  value: S,
): Module<Exclude<Requirements<M>, I>, Errors<M>> =>
  mapTools(
    module,
    (tools) => ToolRegistry.provideService(tools, service, value),
    Effect.provideService(service, value),
  ) as never

export const provideLayer = <M extends Module<any, any>, L extends Layer.Any>(
  module: M,
  layer: L,
): Module<
  Layer.Services<L> | Exclude<Requirements<M>, Layer.Success<L>>,
  Errors<M> | Layer.Error<L>
> =>
  mapTools(
    module,
    (tools) => ToolRegistry.provideLayer(tools, layer),
    // SAFETY: L is constrained to Layer.Any and these utility types are its
    // corresponding output, error, and input channels.
    Effect.provide(
      layer as unknown as Layer.Layer<Layer.Success<L>, Layer.Error<L>, Layer.Services<L>>,
    ),
  ) as never

export const Module = Object.assign(make, {
  empty,
  instructions,
  tool,
  all,
  when,
  provide,
  provideLayer,
})
