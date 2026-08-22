import { Context, Effect, type Layer, type Scope } from "effect"

import * as Middleware from "../src/Middleware.ts"

class Dependency extends Context.Service<Dependency, { readonly enabled: boolean }>()(
  "types/MiddlewareDependency",
) {}

class MiddlewareFailure {
  readonly _tag = "MiddlewareFailure"
}

const typed = Middleware.make<Dependency, MiddlewareFailure>({
  step: (next) => (input) =>
    Effect.gen(function* () {
      const dependency = yield* Dependency
      if (!dependency.enabled) return yield* Effect.fail(new MiddlewareFailure())
      return yield* next(input)
    }),
})

const scoped = Middleware.layerScoped<never, never>(
  "types",
  Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.void)
    return Middleware.empty
  }),
)

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T
type Channels<T> = T extends Middleware.Middleware<infer R, infer E> ? readonly [R, E] : never
type Requirements = Channels<typeof typed>[0]
type Errors = Channels<typeof typed>[1]
type LayerRequirements = typeof scoped extends Layer.Layer<unknown, unknown, infer R> ? R : never

export type MiddlewareRequirementPreserved = Assert<Equal<Requirements, Dependency>>
export type MiddlewareErrorPreserved = Assert<Equal<Errors, MiddlewareFailure>>
export type ScopedLayerRemovesScope = Assert<Equal<Extract<LayerRequirements, Scope.Scope>, never>>
export type ScopedLayerHasNoRequirements = Assert<Equal<LayerRequirements, never>>
