import { Context, Effect, Layer, Schema } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import type * as Tool from "effect/unstable/ai/Tool"

/** Per-call context threaded through every seam by the loop. */
export interface RunContext {
  readonly sessionId: string
  readonly turn: number
  readonly step: number
}

export interface ToolCallInfo {
  readonly name: string
  readonly params: Tool.Parameters<Tool.Any>
}

/** A hook's rejection before a model step is admitted. */
export class StepRejected extends Schema.TaggedErrorClass<StepRejected>()("StepRejected", {
  message: Schema.String,
}) {}

/**
 * A hook's veto against executing a tool call. The loop surfaces it to the
 * model as a failed tool result (`{ type: "execution-denied", reason }`), the
 * same envelope effect/unstable/ai uses for its own approval denials, so the
 * run continues instead of failing.
 */
export class ToolRejected extends Schema.TaggedErrorClass<ToolRejected>()("ToolRejected", {
  reason: Schema.String,
}) {}

export interface StopRequest {
  readonly reason: "completed" | "stopped" | "interrupted"
  readonly stepCount: number
}

/** A `turnStopping` veto: the supplied prompt drives the next turn. */
export interface ContinueTurn {
  readonly prompt: string
}

export interface AgentHooksInterface {
  /** Notification before each model request. */
  readonly preStep: (context: RunContext) => Effect.Effect<void, StepRejected>
  /**
   * May rewrite the request the model sees (e.g. a compacted prompt). The
   * durable log records both the full conversation and this model-facing view.
   */
  readonly beforeRequest: (
    context: RunContext,
    request: ModelRequest,
  ) => Effect.Effect<ModelRequest>
  /** May rewrite params, or reject with `ToolRejected` to deny execution. */
  readonly beforeToolExecute: (
    context: RunContext,
    call: ToolCallInfo,
  ) => Effect.Effect<ToolCallInfo, ToolRejected>
  /** Notification after a final (non-preliminary) tool result. */
  readonly afterToolExecute: (
    context: RunContext,
    call: ToolCallInfo,
    isFailure: boolean,
  ) => Effect.Effect<void>
  /**
   * Fires whenever the loop is about to end a turn with a non-failure reason.
   * Returning a `ContinueTurn` journals that prompt and starts another turn.
   */
  readonly turnStopping: (
    context: RunContext,
    stop: StopRequest,
  ) => Effect.Effect<ContinueTurn | undefined>
}

/**
 * The request `LanguageModel.Service.streamText` receives: the normalized
 * prompt plus its model-facing options. `beforeRequest` rewrites this shape;
 * loop-owned options (toolkit and concurrency) are reapplied afterward.
 */
export type ModelRequest = Pick<
  LanguageModel.GenerateTextOptions<Record<string, import("effect/unstable/ai/Tool").Any>>,
  "prompt" | "toolChoice"
>

export const hooksNoop: AgentHooksInterface = {
  preStep: () => Effect.void,
  beforeRequest: (_context, request) => Effect.succeed(request),
  beforeToolExecute: (_context, call) => Effect.succeed(call),
  afterToolExecute: () => Effect.void,
  turnStopping: () => Effect.as(Effect.void, undefined),
}

export interface AgentHooks extends AgentHooksInterface {}

export const AgentHooks = Context.Reference<AgentHooks>("roop/AgentHooks", {
  defaultValue: () => hooksNoop,
})

/** Explicit layer retained for composing hook waterfalls. */
export const layerNoop =
  /* SAFETY: Context.Reference identifiers are `never`, so Layer.succeed types the
   * provided service as never; the runtime key is still AgentHooks. */
  Layer.succeed(AgentHooks, hooksNoop) as Layer.Layer<AgentHooks>

/**
 * Build one waterfall stage. The returned layer requires the downstream
 * `AgentHooks` — satisfied by the next `layerHook` or by `layerNoop` at the
 * end of the chain — plus whatever services the hook itself needs. Compose
 * with `Layer.provide`: the first-provided hook is outermost, so it sees
 * requests first and results last.
 *
 * ```ts
 * const approval = layerHook("approval", (downstream) =>
 *   Effect.succeed({
 *     ...downstream,
 *     beforeToolExecute: (context, call) =>
 *       call.name === "shell"
 *         ? askHuman(call).pipe(Effect.andThen(call))
 *         : downstream.beforeToolExecute(context, call),
 *   }))
 * ```
 */
export const layerHook = <R = never>(
  name: string,
  wrap: (downstream: AgentHooksInterface) => Effect.Effect<AgentHooksInterface, never, R>,
): Layer.Layer<AgentHooks, never, AgentHooks | R> =>
  /* SAFETY: Context.Reference identifiers are `never`, so Layer.effect types the
   * provided service as never; the runtime key is still AgentHooks. */
  Layer.effect(
    AgentHooks,
    Effect.gen(function* () {
      const downstream = yield* AgentHooks
      return yield* wrap(downstream)
    }),
  ).pipe(Layer.withSpan(`AgentHooks/${name}`)) as Layer.Layer<AgentHooks, never, AgentHooks | R>
