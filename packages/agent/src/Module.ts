/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-escape-hatch-assertions, anti-slop/require-safety-comment-for-type-assertion -- module and Layer composition cross existential Effect boundaries after preserving their typed channels. */

import { Effect, type Context, type Layer } from "effect"
import type * as Tool from "effect/unstable/ai/Tool"
import * as Toolkit from "effect/unstable/ai/Toolkit"

import type { AgentContext } from "./AgentContext.ts"
import { ToolRegistry, type ToolContribution } from "./ToolRegistry.ts"

export interface InstructionFragment {
  readonly text: string
  readonly contributor: string
}

export interface AgentContribution<out R = never, out E = never> {
  readonly instructions: ReadonlyArray<InstructionFragment>
  readonly tools: ToolRegistry<R, E>
}

export interface Module<out R = never, out E = never> {
  readonly build: (context: AgentContext) => Effect.Effect<AgentContribution<R, E>, E, R>
}

export type Requirements<M> = M extends Module<infer R, infer _E> ? R : never
export type Errors<M> = M extends Module<infer _R, infer E> ? E : never

interface ModuleInput {
  readonly build: (context: AgentContext) => object
}

const buildModule = <M extends ModuleInput>(
  module: M,
  context: AgentContext,
): Effect.Effect<AgentContribution<Requirements<M>, Errors<M>>, Errors<M>, Requirements<M>> =>
  /* SAFETY: ModuleInput hides only the channels that Requirements and Errors
   * recover from the concrete Module type. */
  module.build(context) as Effect.Effect<
    AgentContribution<Requirements<M>, Errors<M>>,
    Errors<M>,
    Requirements<M>
  >

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
  const handlers = toolkit.toLayer({
    [definition.name]: (params: Tool.Parameters<T>, context: Toolkit.HandlerContext<T>) =>
      handler(params, context),
  } as never)
  const entry: ToolContribution<R | Tool.HandlerServices<T>, E> = {
    tool: definition,
    contributor: contributor ?? definition.name,
    toolkit,
    handlers,
  }
  return make(() => Effect.succeed(contribution([], ToolRegistry.fromContribution(entry))))
}

export const all = <const Modules extends ReadonlyArray<ModuleInput>>(
  ...modules: Modules
): Module<Requirements<Modules[number]>, Errors<Modules[number]>> =>
  make(
    (context) =>
      Effect.all(modules.map((module) => buildModule(module, context))).pipe(
        Effect.map((parts) =>
          parts.reduce<AgentContribution<Requirements<Modules[number]>, Errors<Modules[number]>>>(
            (result, part) =>
              contribution(
                [...result.instructions, ...part.instructions],
                ToolRegistry.combine(result.tools, part.tools),
              ),
            contribution([], ToolRegistry.empty),
          ),
        ),
      ),
    /* SAFETY: all module effects are collected in declaration order; only their
     * existential contribution records are hidden at this public boundary. */
  ) as Module<Requirements<Modules[number]>, Errors<Modules[number]>>

export function when<M extends ModuleInput>(
  condition: boolean | ((context: AgentContext) => boolean),
  module: M,
): Module<Requirements<M>, Errors<M>>
export function when<M extends ModuleInput, R, E>(
  condition: (context: AgentContext) => Effect.Effect<boolean, E, R>,
  module: M,
): Module<Requirements<M> | R, Errors<M> | E>
export function when<M extends ModuleInput, R, E>(
  condition: boolean | ((context: AgentContext) => boolean | Effect.Effect<boolean, E, R>),
  module: M,
): Module<Requirements<M> | R, Errors<M> | E> {
  return make((context) => {
    const selected = typeof condition === "function" ? condition(context) : condition
    const decision = typeof selected === "boolean" ? Effect.succeed(selected) : selected
    return decision.pipe(
      Effect.flatMap((enabled) => (enabled ? buildModule(module, context) : empty.build(context))),
    )
  })
}

export const provide = <M extends ModuleInput, I, S>(
  module: M,
  service: Context.Key<I, S>,
  value: S,
): Module<Exclude<Requirements<M>, I>, Errors<M>> =>
  /* SAFETY: the supplied service is exactly the Context.Key removed from R. */
  make((context) =>
    buildModule(module, context).pipe(Effect.provideService(service, value)),
  ) as never

export const provideLayer = <M extends ModuleInput, L extends Layer.Any>(
  module: M,
  layer: L,
): Module<
  Layer.Services<L> | Exclude<Requirements<M>, Layer.Success<L>>,
  Errors<M> | Layer.Error<L>
> =>
  /* SAFETY: the supplied Layer output is exactly the service set removed from R. */
  make((context) =>
    buildModule(module, context).pipe(
      Effect.provide(
        // SAFETY: L is constrained to Layer.Any and these utility types are its
        // corresponding output, error, and input channels.
        layer as unknown as Layer.Layer<Layer.Success<L>, Layer.Error<L>, Layer.Services<L>>,
      ),
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
