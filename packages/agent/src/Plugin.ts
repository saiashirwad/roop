import { Layer, type Context, type Crypto, type Effect, type Schema } from "effect"
import * as Tool from "effect/unstable/ai/Tool"
import * as Toolkit from "effect/unstable/ai/Toolkit"

import { AgentLive, type Agent } from "./Agent.ts"
import { layer as agentConfigLayer } from "./AgentConfig.ts"
import { layerNoop, type AgentHooks } from "./AgentHooks.ts"
import { layer as agentToolsLayer } from "./AgentTools.ts"
import { PluginId } from "./DomainIds.ts"
import { layer as modelCatalogLayer, type ModelSpec } from "./ModelCatalog.ts"
import { RunRegistryLive } from "./RunRegistry.ts"
import type { SessionJournal } from "./SessionJournal.ts"
import type { Skill } from "./Skills.ts"

export interface Plugin<out R = never, out E = never, out RH = never> {
  readonly id: PluginId
  readonly name: string
  readonly toolkit?: Toolkit.Toolkit<any> | undefined
  readonly handlers?: Layer.Layer<any, E, R> | undefined
  readonly hooks?: Layer.Layer<AgentHooks, E, AgentHooks | R | RH> | undefined
  readonly models?: ReadonlyArray<ModelSpec<E, R>> | undefined
  readonly skills?: ReadonlyArray<Skill> | undefined
  readonly systemPrompt?: string | undefined
  readonly promptSections?: ReadonlyArray<string> | undefined
  readonly _R?: (_: never) => R
  readonly _E?: (_: never) => E
  readonly _RH?: (_: never) => RH
}

export interface PluginOptions<
  Tools extends Record<string, Tool.Any> = Record<string, never>,
  R = never,
  E = never,
  RH = never,
> {
  readonly id?: PluginId | string | undefined
  readonly name?: string | undefined
  readonly toolkit?: Toolkit.Toolkit<Tools> | undefined
  readonly handlers?: Layer.Layer<Tool.HandlersFor<Tools>, E, R> | undefined
  readonly hooks?: Layer.Layer<AgentHooks, E, AgentHooks | NoInfer<R> | RH> | undefined
  readonly models?: ReadonlyArray<ModelSpec<E, R>> | undefined
  readonly skills?: ReadonlyArray<Skill> | undefined
  readonly systemPrompt?: string | undefined
  readonly promptSections?: ReadonlyArray<string> | undefined
  /** Type-only hook service requirements. */
  readonly _hookRequirements?: RH | undefined
}

export const make = <
  Tools extends Record<string, Tool.Any> = Record<string, never>,
  R = never,
  E = never,
  RH = never,
>(
  options: PluginOptions<Tools, R, E, RH>,
): Plugin<R, E, RH> => {
  const pluginId =
    options.id !== undefined
      ? PluginId.make(options.id)
      : options.name !== undefined
        ? PluginId.make(options.name)
        : PluginId.make("anonymous-plugin")
  const name = options.name ?? String(pluginId)

  return {
    id: pluginId,
    name,
    toolkit: options.toolkit,
    handlers: options.handlers,
    hooks: options.hooks,
    models: options.models,
    skills: options.skills,
    systemPrompt: options.systemPrompt,
    promptSections: options.promptSections,
  }
}

export interface PluginToolOptions<
  Name extends string,
  Parameters extends Schema.Constraint,
  Success extends Schema.Constraint,
  Failure extends Schema.Constraint,
  Mode extends Tool.FailureMode,
  Handler extends Effect.Effect<any, any, any>,
> {
  readonly name: Name
  readonly description?: string | undefined
  readonly parameters: Parameters
  readonly success: Success
  readonly failure?: Failure | undefined
  readonly failureMode?: Mode | undefined
  readonly dependencies?: ReadonlyArray<Context.Key<any, any>> | undefined
  readonly handler: (params: Parameters["Type"]) => Handler
  readonly plugin?: Omit<PluginOptions, "toolkit" | "handlers"> | undefined
}

/** Define one tool and install its handler as a plugin in one expression. */
export const tool = <
  const Name extends string,
  Parameters extends Schema.Constraint,
  Success extends Schema.Constraint,
  Failure extends Schema.Constraint = typeof Schema.Never,
  Mode extends Tool.FailureMode = "error",
  Handler extends Effect.Effect<any, any, any> = Effect.Effect<any, any, any>,
>(
  options: PluginToolOptions<Name, Parameters, Success, Failure, Mode, Handler>,
): Plugin<Effect.Services<Handler>, Effect.Error<Handler>> => {
  const { handler, plugin, ...definition } = options
  /* SAFETY: `definition` is exactly the runtime option subset accepted by Tool.make. */
  const definitionTool = Tool.make(options.name, definition as never)
  const toolkit = Toolkit.make(definitionTool)
  /* SAFETY: Toolkit.make has one handler whose parameter and result types are supplied by `handler`. */
  const handlers = toolkit.toLayer({
    [options.name]: (params: Parameters["Type"]) => handler(params),
  } as never)
  const result: unknown = make({
    ...plugin,
    name: plugin?.name ?? options.name,
    toolkit,
    handlers,
  })
  /* SAFETY: the handler effect is the only open requirement/error channel introduced by this tool. */
  return result as Plugin<Effect.Services<Handler>, Effect.Error<Handler>>
}

export const Plugin = Object.assign(make, {
  make,
  tool,
})

/* oxlint-disable effecttsgo/any-unknown-in-error-context -- plugin lists are existentially typed: each element may require a distinct service union. */
export type PluginRequirements<Plugins extends ReadonlyArray<Plugin<any, any, any>>> =
  Plugins[number] extends Plugin<infer R, any, infer RH>
    ? (0 extends 1 & R ? never : R) | (0 extends 1 & RH ? never : RH)
    : never

export type PluginErrors<Plugins extends ReadonlyArray<Plugin<any, any, any>>> =
  Plugins[number] extends Plugin<any, infer E, any> ? (0 extends 1 & E ? never : E) : never

export const AgentPlugins = <const Plugins extends ReadonlyArray<Plugin<any, any, any>>>(
  plugins: Plugins,
  options?: {
    readonly systemPrompt?: string | undefined
  },
): Layer.Layer<
  Agent,
  never,
  SessionJournal | Crypto.Crypto | Exclude<PluginRequirements<Plugins>, never>
> => {
  const toolkits = plugins.flatMap((plugin) =>
    plugin.toolkit === undefined ? [] : [plugin.toolkit],
  )
  const handlerLayers = plugins.flatMap((plugin) =>
    plugin.handlers === undefined ? [] : [plugin.handlers],
  )
  const allTools = toolkits.reduce(
    (merged, toolkit) => Toolkit.merge(merged, toolkit),
    Toolkit.empty,
  )
  // SAFETY: Effect 4's mergeAll declaration requires an array of layers with
  // an erased output here; the existential plugin boundary has already erased
  // each handler layer's concrete output type.
  const erasedHandlerLayers = handlerLayers as Array<Layer.Layer<never, any, any>>
  const allHandlers = Layer.mergeAll(Layer.empty, ...erasedHandlerLayers)
  const tools = agentToolsLayer(allTools, allHandlers.pipe(Layer.orDie))

  const sections = [
    options?.systemPrompt,
    ...plugins.flatMap((plugin) => [plugin.systemPrompt, ...(plugin.promptSections ?? [])]),
  ].filter((text): text is string => text !== undefined && text !== "")
  const config = agentConfigLayer({
    systemPrompt: sections.join("\n\n"),
    skills: plugins.flatMap((plugin) => plugin.skills ?? []),
  })

  const hooks = plugins
    .flatMap((plugin) => (plugin.hooks === undefined ? [] : [plugin.hooks]))
    .reduceRight<Layer.Layer<AgentHooks, any, any>>(
      (downstream, hook) => hook.pipe(Layer.provide(downstream)),
      // SAFETY: Every plugin hook layer consumes the AgentHooks service
      // produced by the next layer, ending in the explicit no-op layer.
      layerNoop as Layer.Layer<AgentHooks, any, any>,
    )
  const models = modelCatalogLayer(plugins.flatMap((plugin) => plugin.models ?? [])).pipe(
    Layer.orDie,
  )

  // SAFETY: The existential plugin array has been fully composed above; its
  // only remaining requirements are the union represented by PluginRequirements.
  return Layer.fresh(AgentLive).pipe(
    Layer.orDie,
    Layer.provide([tools, config, hooks, models, RunRegistryLive]),
  ) as Layer.Layer<
    Agent,
    never,
    SessionJournal | Crypto.Crypto | Exclude<PluginRequirements<Plugins>, never>
  >
}
/* oxlint-enable effecttsgo/any-unknown-in-error-context */
