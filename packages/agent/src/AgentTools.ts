import { Context, Effect, Layer } from "effect"
import type { Toolkit } from "effect/unstable/ai"
import type * as Tool from "effect/unstable/ai/Tool"

import { eraseToolkit, type ErasedToolkit } from "./runStep.ts"

/** The complete, immutable toolkit for one agent instance. */
export class AgentTools extends Context.Service<AgentTools, ErasedToolkit>()("roop/AgentTools") {}

/** Build the complete immutable toolkit from its merged definitions and handlers. */
export const layer = <Tools extends Record<string, Tool.Any>, E, R>(
  toolkit: Toolkit.Toolkit<Tools>,
  handlers: Layer.Layer<Tool.HandlersFor<Tools>, E, R>,
): Layer.Layer<AgentTools, E, R> =>
  Layer.effect(AgentTools, toolkit.pipe(Effect.map(eraseToolkit))).pipe(Layer.provide(handlers))
