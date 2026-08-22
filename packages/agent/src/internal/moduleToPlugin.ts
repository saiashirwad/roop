/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- this temporary bridge crosses the old Plugin's existential handler layer boundary. */

import { Effect, type Layer } from "effect"
import * as Toolkit from "effect/unstable/ai/Toolkit"

import type { AgentDefinition } from "../Agent.ts"
import type { AgentContext } from "../AgentContext.ts"
import { Plugin, type Plugin as PluginValue } from "../Plugin.ts"
import type { InvalidToolName, ToolConflict } from "../ToolRegistry.ts"

/**
 * Temporary U2 adapter. It lets a rendered explicit agent use the old
 * Plugin/AgentPlugins interpreter while the runtime migration is in progress.
 * This module is internal and must disappear after the public extension proofs.
 */
export const moduleToPlugin = <R, E>(
  agent: AgentDefinition<R, E>,
  context: AgentContext,
): Effect.Effect<PluginValue<R, E>, E | InvalidToolName | ToolConflict, R> =>
  Effect.gen(function* () {
    const plan = yield* agent.render(context)
    const finalized = yield* plan.tools.finalize
    const toolkit = Toolkit.make(...finalized.tools)
    /* SAFETY: Plugin is the temporary internal adapter and preserves the
     * explicit agent's name, handlers, instructions, and validated tools. */
    return Plugin({
      name: agent.name,
      toolkit,
      /* SAFETY: finalization has validated every tool and this Layer contains
       * only the handlers for the returned toolkit. */
      handlers: finalized.handlers as Layer.Layer<any, E, R>,
      systemPrompt: plan.instructions.map((item) => item.text).join("\n\n"),
    }) as PluginValue<R, E>
  })
