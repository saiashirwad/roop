/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-escape-hatch-assertions, anti-slop/require-safety-comment-for-type-assertion -- registry finalization crosses one intentional existential Effect AI boundary after conflict validation. */

import { Effect, Layer, Schema, type Stream } from "effect"
import type * as AiError from "effect/unstable/ai/AiError"
import type * as Tool from "effect/unstable/ai/Tool"
import * as Toolkit from "effect/unstable/ai/Toolkit"

const eraseToolkit = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.WithHandler<Tools>,
): Toolkit.WithHandler<Record<string, Tool.Any>> =>
  /* SAFETY: Effect AI validates each named call against the matching tool schema. */
  toolkit as unknown as Toolkit.WithHandler<Record<string, Tool.Any>>

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

/** A typed tool declaration plus its Effect AI handler layer. */
export interface ToolContribution<out R = never, out E = never> {
  readonly tool: Tool.Any
  readonly contributor: string
  readonly toolkit: Toolkit.Any
  readonly handlers: ErasedHandlerLayer
  readonly _R?: (_: never) => R
  readonly _E?: (_: never) => E
}

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

type ErasedHandlerLayer = Layer.Layer<never>

interface RegistryInput {
  readonly contributions: ReadonlyArray<unknown>
}

type RegistryRequirements<T> = T extends ToolRegistry<infer R, infer _E> ? R : never
type RegistryErrors<T> = T extends ToolRegistry<infer _R, infer E> ? E : never

export interface ToolRegistry<out R = never, out E = never> {
  readonly contributions: ReadonlyArray<ToolContribution<R, E>>
  readonly finalize: Effect.Effect<FinalizedToolRegistry, ToolConflict | InvalidToolName | E, R>
}

const finalizeContributions = Effect.fn("ToolRegistry.finalize")(function* <R, E>(
  contributions: ReadonlyArray<ToolContribution<R, E>>,
) {
  const byName = new Map<string, Array<ToolContribution<R, E>>>()
  for (const contribution of contributions) {
    const name = contribution.tool.name
    if (name.trim() === "") {
      return yield* new InvalidToolName({ name, contributor: contribution.contributor })
    }
    const entries = byName.get(name)
    if (entries === undefined) byName.set(name, [contribution])
    else entries.push(contribution)
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
  const toolkit =
    tools.length === 0
      ? Toolkit.empty
      : Toolkit.make(
          /* SAFETY: the length guard proves this is a non-empty tool tuple. */
          ...(tools as [Tool.Any, ...Array<Tool.Any>]),
        )
  const handlerLayers = contributions.map((contribution) => contribution.handlers)
  const handlers: ErasedHandlerLayer =
    handlerLayers.length === 0
      ? Layer.empty
      : Layer.mergeAll(
          /* SAFETY: the length guard proves this is a non-empty layer tuple. */
          ...(handlerLayers as [ErasedHandlerLayer, ...Array<ErasedHandlerLayer>]),
        )
  // SAFETY: all tool names were validated as unique above. The existential
  // handler relationship is erased once, at this Effect AI boundary.
  const installed = yield* (toolkit as Toolkit.Toolkit<Record<string, Tool.Any>>).pipe(
    Effect.map(eraseToolkit),
    /* SAFETY: handlers are the layers created for these exact tool definitions. */
    Effect.provide(handlers as unknown as Layer.Layer<Tool.Handler<string>>),
  )
  return {
    /* SAFETY: finalization installs the handler layers and captures their
     * services. Dynamic calls retain the registry error channel. */
    toolkit: installed as unknown as FinalizedToolkit,
    tools,
    handlers,
  }
})

const makeRegistry = <R, E>(
  contributions: ReadonlyArray<ToolContribution<R, E>>,
): ToolRegistry<R, E> => ({
  contributions,
  /* SAFETY: finalize has the same channels; the cast only restores the
   * existential contribution type hidden by the runtime collection. */
  finalize: finalizeContributions(contributions) as ToolRegistry<R, E>["finalize"],
})

export const empty: ToolRegistry = makeRegistry([])

export const fromContribution = <R, E>(contribution: ToolContribution<R, E>): ToolRegistry<R, E> =>
  makeRegistry([contribution])

export const combine = <const Registries extends ReadonlyArray<RegistryInput>>(
  ...registries: Registries
): ToolRegistry<RegistryRequirements<Registries[number]>, RegistryErrors<Registries[number]>> =>
  makeRegistry(
    registries.flatMap((registry) => registry.contributions) as ReadonlyArray<
      ToolContribution<RegistryRequirements<Registries[number]>, RegistryErrors<Registries[number]>>
    >,
  )

export const ToolRegistry = Object.assign(makeRegistry, {
  empty,
  fromContribution,
  combine,
})
