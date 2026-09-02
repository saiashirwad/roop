/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-escape-hatch-assertions, anti-slop/require-safety-comment-for-type-assertion -- finalize is the single existential Effect AI boundary; it erases handler services once, after conflict validation. */

import { Array as Arr, type Context, Effect, Layer, Schema, type Scope, type Stream } from "effect"
import type * as AiError from "effect/unstable/ai/AiError"
import type * as Tool from "effect/unstable/ai/Tool"
import * as Toolkit from "effect/unstable/ai/Toolkit"

/** A tool name was empty and cannot be sent to a model. */
export class InvalidToolName extends Schema.TaggedErrorClass<InvalidToolName>()("InvalidToolName", {
  name: Schema.String,
  contributor: Schema.String,
}) {
  override get message(): string {
    return `Tool name must not be empty (contributor: ${this.contributor})`
  }
}

/** All declarations of one duplicate tool name, in declaration order. */
export class ToolConflict extends Schema.TaggedErrorClass<ToolConflict>()("ToolConflict", {
  name: Schema.String,
  contributors: Schema.Array(Schema.String),
}) {
  override get message(): string {
    return `Tool ${this.name} was declared by: ${this.contributors.join(", ")}`
  }
}

type ErasedHandlerLayer = Layer.Layer<never>

/** A typed tool declaration plus its Effect AI handler layer. */
export interface ToolContribution {
  readonly tool: Tool.Any
  readonly contributor: string
  readonly toolkit: Toolkit.Any
  readonly handlers: ErasedHandlerLayer
}

/** An installed toolkit whose handler services were satisfied at finalize time. */
export interface FinalizedToolkit extends Omit<
  Toolkit.WithHandler<Record<string, Tool.Any>>,
  "handle"
> {
  readonly handle: (
    name: string,
    params: Tool.Parameters<Tool.Any>,
  ) => Effect.Effect<Stream.Stream<Tool.HandlerResult<Tool.Any>>, AiError.AiError>
}

export interface FinalizedToolRegistry {
  readonly toolkit: FinalizedToolkit
  readonly tools: ReadonlyArray<Tool.Any>
  readonly handlers: ErasedHandlerLayer
}

export interface ToolRegistry<out R = never, out E = never> {
  readonly contributions: ReadonlyArray<ToolContribution>
  readonly finalize: Effect.Effect<
    FinalizedToolRegistry,
    ToolConflict | InvalidToolName | E,
    R | Scope.Scope
  >
}

type Requirements<T> = T extends ToolRegistry<infer R, infer _E> ? R : never
type Errors<T> = T extends ToolRegistry<infer _R, infer E> ? E : never

const finalizeContributions = Effect.fn("ToolRegistry.finalize")(function* (
  contributions: ReadonlyArray<ToolContribution>,
) {
  const byName = new Map<string, Array<ToolContribution>>()
  for (const contribution of contributions) {
    const name = contribution.tool.name
    if (name.trim() === "") {
      return yield* new InvalidToolName({ name, contributor: contribution.contributor })
    }
    byName.set(name, [...(byName.get(name) ?? []), contribution])
  }
  for (const [name, entries] of byName) {
    if (entries.length > 1) {
      return yield* new ToolConflict({
        name,
        contributors: entries.map((entry) => entry.contributor),
      })
    }
  }

  const tools = contributions.map((contribution) => contribution.tool)
  const toolkit = Arr.isArrayNonEmpty(tools) ? Toolkit.make(...tools) : Toolkit.empty
  const handlerLayers = contributions.map((contribution) => contribution.handlers)
  const handlers: ErasedHandlerLayer = Arr.isArrayNonEmpty(handlerLayers)
    ? Layer.mergeAll(...handlerLayers)
    : Layer.empty
  // SAFETY: all tool names were validated as unique above. The existential
  // handler relationship is erased once, at this Effect AI boundary.
  const handlerContext = yield* Layer.build(
    handlers as unknown as Layer.Layer<Tool.Handler<string>>,
  )
  const installed = yield* (toolkit as Toolkit.Toolkit<Record<string, Tool.Any>>).pipe(
    Effect.provide(handlerContext),
  )
  return {
    toolkit: installed as unknown as FinalizedToolkit,
    tools,
    handlers,
  } satisfies FinalizedToolRegistry
})

/** R and E are the constructor's claim about the erased handler layers. */
const makeRegistry = <R, E>(
  contributions: ReadonlyArray<ToolContribution>,
): ToolRegistry<R, E> => ({
  contributions,
  finalize: finalizeContributions(contributions),
})

export const empty: ToolRegistry = makeRegistry([])

export const fromContribution = <R, E>(contribution: ToolContribution): ToolRegistry<R, E> =>
  makeRegistry([contribution])

export const combine = <const Registries extends ReadonlyArray<ToolRegistry<any, any>>>(
  ...registries: Registries
): ToolRegistry<Requirements<Registries[number]>, Errors<Registries[number]>> =>
  makeRegistry(registries.flatMap((registry) => registry.contributions))

/** Satisfy part of every contribution's handler requirements with one layer. */
const provideHandlers = <R, E, ROut, E2, RIn>(
  registry: ToolRegistry<R, E>,
  layer: Layer.Layer<ROut, E2, RIn>,
): ToolRegistry<RIn | Exclude<R, ROut>, E | E2> =>
  makeRegistry(
    registry.contributions.map((contribution) => ({
      ...contribution,
      handlers: Layer.provide(
        contribution.handlers as unknown as Layer.Layer<never, never, R>,
        layer,
      ) as ErasedHandlerLayer,
    })),
  ) as ToolRegistry<RIn | Exclude<R, ROut>, E | E2>

export const provideService = <R, E, I, S>(
  registry: ToolRegistry<R, E>,
  service: Context.Key<I, S>,
  value: S,
): ToolRegistry<Exclude<R, I>, E> => provideHandlers(registry, Layer.succeed(service, value))

export const provideLayer = <R, E, L extends Layer.Any>(
  registry: ToolRegistry<R, E>,
  layer: L,
): ToolRegistry<Layer.Services<L> | Exclude<R, Layer.Success<L>>, E | Layer.Error<L>> =>
  provideHandlers(
    registry,
    layer as unknown as Layer.Layer<Layer.Success<L>, Layer.Error<L>, Layer.Services<L>>,
  )

export const ToolRegistry = Object.assign(makeRegistry, {
  empty,
  fromContribution,
  combine,
  provideService,
  provideLayer,
})
