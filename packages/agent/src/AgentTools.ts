import { Context, Effect, Layer } from "effect"
import type { Toolkit } from "effect/unstable/ai"
import type * as Tool from "effect/unstable/ai/Tool"

export type ErasedToolkit = Toolkit.WithHandler<Record<string, Tool.Any>>

/**
 * Erase a toolkit's name-to-parameter relationship after its handlers have
 * been built. Toolkit itself still validates every call before dispatching it.
 */
export const eraseToolkit = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.WithHandler<Tools>,
): ErasedToolkit => {
  /* SAFETY: Tool names originate from `toolkit.tools`; Toolkit validates the
   * corresponding parameters before invoking the handler. */
  return { tools: toolkit.tools, handle: toolkit.handle } as ErasedToolkit
}

/** The complete, immutable toolkit for one agent instance. */
export class AgentTools extends Context.Service<AgentTools, ErasedToolkit>()("roop/AgentTools") {}

/** Build the complete immutable toolkit from its merged definitions and handlers. */
export const layer = <Tools extends Record<string, Tool.Any>, E, R>(
  toolkit: Toolkit.Toolkit<Tools>,
  handlers: Layer.Layer<Tool.HandlersFor<Tools>, E, R>,
): Layer.Layer<AgentTools, E, R> =>
  Layer.effect(AgentTools, toolkit.pipe(Effect.map(eraseToolkit))).pipe(Layer.provide(handlers))
