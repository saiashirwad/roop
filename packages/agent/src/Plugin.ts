import { Effect, Layer } from "effect"
import { Toolkit } from "effect/unstable/ai"
import type * as Tool from "effect/unstable/ai/Tool"

import { AgentLive, type Agent } from "./Agent.ts"
import { AgentContextLive } from "./AgentContext.ts"
import { AgentHooks, layerNoop } from "./AgentHooks.ts"
import { ModelCatalogLive, type ModelSpec } from "./ModelCatalog.ts"
import type { SessionStore } from "./SessionStore.ts"
import { Skills, type Skill } from "./Skills.ts"

export type Plugin<R = never, RH = never> = {
  readonly name: string
  readonly toolkit?: Toolkit.Toolkit<Record<string, Tool.Any>> | undefined
  readonly handlers?: Layer.Layer<never, never, R> | undefined
  /**
   * A hook waterfall stage (see `layerHook`) — by construction it requires the
   * downstream `AgentHooks`, which `AgentPlugins` provides when composing the
   * chain. Plugins compose outermost-first: an earlier plugin's hooks see
   * requests before, and results after, a later plugin's.
   */
  readonly hooks?: Layer.Layer<AgentHooks, never, AgentHooks | NoInfer<R>> | undefined
  readonly models?: ReadonlyArray<ModelSpec<never, R>> | undefined
  readonly skills?: ReadonlyArray<Skill> | undefined
  readonly systemPrompt?: string | undefined
  /** Type-only hook service requirements. */
  readonly _hookRequirements?: RH
}

export const Plugin = <Tools extends Record<string, Tool.Any>, R = never, RH = never>(options: {
  readonly name: string
  readonly toolkit?: Toolkit.Toolkit<Tools>
  readonly handlers?: Layer.Layer<Tool.HandlersFor<Tools>, never, R>
  readonly hooks?: Layer.Layer<AgentHooks, never, AgentHooks | NoInfer<R> | RH>
  readonly models?: ReadonlyArray<ModelSpec<never, R>>
  readonly skills?: ReadonlyArray<Skill>
  readonly systemPrompt?: string
/* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
}): Plugin<R, RH> => options as unknown as Plugin<R, RH>

type ErasedTools = Record<string, Tool.Any>

export type PluginRequirements<Plugins extends ReadonlyArray<Plugin<any, any>>> =
  Plugins[number] extends Plugin<infer R, infer RH> ? R | RH : never

export const AgentPlugins = <const Plugins extends ReadonlyArray<Plugin<any>>>(
  plugins: Plugins,
  options?: { readonly systemPrompt?: string | undefined },
): Layer.Layer<Agent, never, SessionStore | PluginRequirements<Plugins>> => {
  /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
  const toolkit = Toolkit.merge(
    ...plugins.flatMap((plugin) => (plugin.toolkit === undefined ? [] : [plugin.toolkit])),
  ) as Toolkit.Toolkit<ErasedTools>
  /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
  const handlers = plugins.flatMap((plugin) =>
    plugin.handlers === undefined ? [] : [plugin.handlers],
  ) as unknown as ReadonlyArray<
    Layer.Layer<Tool.HandlersFor<ErasedTools>, never, PluginRequirements<Plugins>>
  >
  const models = plugins.flatMap((plugin) => plugin.models ?? [])
  const skills = plugins.flatMap((plugin) => plugin.skills ?? [])
  const systemPrompt = [options?.systemPrompt, ...plugins.map((plugin) => plugin.systemPrompt)]
    .filter((text): text is string => text !== undefined && text !== "")
    .join("\n\n")

  // Waterfall the hook layers outermost-first over the no-op base.
  const hooks: Layer.Layer<AgentHooks, never, PluginRequirements<Plugins>> = plugins.reduceRight(
    (downstream, plugin) =>
      plugin.hooks === undefined
        ? downstream
        /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
        : (plugin.hooks as Layer.Layer<AgentHooks, never, PluginRequirements<Plugins>>).pipe(
            Layer.provide(downstream),
          ),
    /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
    layerNoop as unknown as Layer.Layer<AgentHooks, never, PluginRequirements<Plugins>>,
  )

  /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
  return Layer.unwrap(Effect.map(toolkit, (withHandler) => AgentLive(withHandler))).pipe(
    Layer.provide([
      AgentContextLive({ systemPrompt }).pipe(
        Layer.provide([ModelCatalogLive(models), Layer.succeed(Skills)({ list: skills })]),
      ),
      hooks,
      ...handlers,
    ]),
  ) as Layer.Layer<Agent, never, SessionStore | PluginRequirements<Plugins>>
}
