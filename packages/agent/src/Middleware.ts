/* oxlint-disable anti-slop/no-unknown-parameters -- middleware helpers accept arbitrary denial payloads across boundaries. */

import { Context, Effect, Layer, type Scope, Stream } from "effect"
import type { LanguageModel, Prompt } from "effect/unstable/ai"
import type * as Tool from "effect/unstable/ai/Tool"

/** Stable location information for one interpreter operation. */
export interface OperationContext {
  readonly sessionId: string
  readonly turn: number
  readonly step: number
}

/** Input for one physical model attempt against one rendered plan. */
export interface ModelCallInput extends OperationContext {
  readonly prompt: Prompt.Prompt
  readonly attempt: number
  readonly model?: LanguageModel.Service | undefined
  readonly planId?: string | undefined
  readonly fingerprint?: string | undefined
  readonly toolNames?: ReadonlyArray<string> | undefined
}

export interface ToolCallInput extends OperationContext {
  readonly name: string
  readonly params: Tool.Parameters<Tool.Any>
}

export interface StepRunInput extends OperationContext {
  readonly stepIndex: number
}

export interface TurnRunInput extends OperationContext {
  readonly stepCount: number
}

export type ModelCall<A, E, R> = (input: ModelCallInput) => Stream.Stream<A, E, R>
export type ToolCall<A, E, R> = (input: ToolCallInput) => Stream.Stream<A, E, R>
export type StepRun<A, E, R> = (input: StepRunInput) => Effect.Effect<A, E, R>
export type TurnRun<A, E, R> = (input: TurnRunInput) => Effect.Effect<A, E, R>

/** Around-style wrappers for each important interpreter boundary. */
export interface Middleware<out R = never, out E = never> {
  readonly model: <A, E1, R1>(next: ModelCall<A, E1, R1>) => ModelCall<A, E | E1, R | R1>
  readonly tool: <A, E1, R1>(next: ToolCall<A, E1, R1>) => ToolCall<A, E | E1, R | R1>
  readonly step: <A, E1, R1>(next: StepRun<A, E1, R1>) => StepRun<A, E | E1, R | R1>
  readonly turn: <A, E1, R1>(next: TurnRun<A, E1, R1>) => TurnRun<A, E | E1, R | R1>
}

/** Identity middleware. */
export const empty: Middleware = {
  model: (next) => next,
  tool: (next) => next,
  step: (next) => next,
  turn: (next) => next,
}

/** Make one middleware value. Omitted boundaries use the identity wrapper. */
export const make = <R = never, E = never>(value: Partial<Middleware<R, E>>): Middleware<R, E> => ({
  model: value.model ?? empty.model,
  tool: value.tool ?? empty.tool,
  step: value.step ?? empty.step,
  turn: value.turn ?? empty.turn,
})

/**
 * Return a model-visible failure result rejecting a tool call without executing its handler.
 */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- callers may pass custom domain-specific rejection structures.
export const denyTool = (reason: string, result?: unknown): Stream.Stream<any, never, never> => {
  const payload = result ?? { type: "execution-denied", reason }
  const part = {
    result: payload,
    encodedResult: payload,
    isFailure: true,
    preliminary: false,
  }
  /* SAFETY: tool middleware produces handler result parts for Effect AI stream consumers. */
  return Stream.make(part as never)
}

/**
 * Compose middleware in declaration order. The leftmost value is outermost,
 * so it sees input first and the result last.
 */
export const all = <R = never, E = never>(
  ...values: ReadonlyArray<Middleware<R, E>>
): Middleware<R, E> => ({
  model: (next) => {
    let result = next
    for (let index = values.length - 1; index >= 0; index--) {
      /* SAFETY: each wrapper keeps A and only widens the declared E and R channels. */
      result = values[index]!.model(result) as typeof next
    }
    return result
  },
  tool: (next) => {
    let result = next
    for (let index = values.length - 1; index >= 0; index--) {
      /* SAFETY: each wrapper keeps A and only widens the declared E and R channels. */
      result = values[index]!.tool(result) as typeof next
    }
    return result
  },
  step: (next) => {
    let result = next
    for (let index = values.length - 1; index >= 0; index--) {
      /* SAFETY: each wrapper keeps A and only widens the declared E and R channels. */
      result = values[index]!.step(result) as typeof next
    }
    return result
  },
  turn: (next) => {
    let result = next
    for (let index = values.length - 1; index >= 0; index--) {
      /* SAFETY: each wrapper keeps A and only widens the declared E and R channels. */
      result = values[index]!.turn(result) as typeof next
    }
    return result
  },
})

/** Layer service for applications that build middleware with dependencies. */
export class MiddlewareService extends Context.Service<MiddlewareService, Middleware>()(
  "roop/Middleware",
) {}

export const layerEmpty: Layer.Layer<MiddlewareService> = Layer.succeed(
  MiddlewareService,
  MiddlewareService.of(empty),
)

/** Build a middleware service while preserving the builder requirements and failures. */
export const layer = <R, E>(
  name: string,
  build: Effect.Effect<Middleware<never, never>, E, R>,
): Layer.Layer<MiddlewareService, E, R> =>
  Layer.effect(MiddlewareService, build.pipe(Effect.map((mw) => MiddlewareService.of(mw)))).pipe(
    Layer.withSpan(`Middleware/${name}`),
  )

/** Build a scoped middleware service. Its finalizer follows the Layer scope. */
export const layerScoped = <R, E>(
  name: string,
  build: Effect.Effect<Middleware<never, never>, E, R | Scope.Scope>,
): Layer.Layer<MiddlewareService, E, R> =>
  Layer.effect(MiddlewareService, build.pipe(Effect.map((mw) => MiddlewareService.of(mw)))).pipe(
    Layer.withSpan(`Middleware/${name}`),
  )
