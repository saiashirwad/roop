import { Crypto, Effect, Layer } from "effect"
import { Toolkit } from "effect/unstable/ai"
import type * as Tool from "effect/unstable/ai/Tool"

import { AgentLive, type Agent } from "./Agent.ts"
import { AgentContext, make as makeAgentContext } from "./AgentContext.ts"
import { AgentHooks, layerNoop } from "./AgentHooks.ts"
import type { ModelSpec } from "./ModelCatalog.ts"
import { PluginId } from "./PluginId.ts"
import type { SessionJournal } from "./SessionJournal.ts"
import { type Skill } from "./Skills.ts"

export type Plugin<R = never, RH = never> = {
  readonly id?: PluginId | string | undefined
  readonly name: string
  readonly toolkit?: Toolkit.Any | undefined
  readonly handlers?: Layer.Layer<never, never, R> | undefined
  /**
   * A hook waterfall stage (see `layerHook`) — by construction it requires the
   * downstream `AgentHooks`, which `AgentPlugins` provides when composing the
   * chain. Plugins compose outermost-first: an earlier plugin's hooks see
   * requests before, and results after, a later plugin's.
   */
  readonly hooks?: Layer.Layer<AgentHooks, never, AgentHooks | NoInfer<R> | RH> | undefined
  readonly models?: ReadonlyArray<ModelSpec<never, R>> | undefined
  readonly skills?: ReadonlyArray<Skill> | undefined
  readonly systemPrompt?: string | undefined
  /** Type-only hook service requirements. */
  readonly _hookRequirements?: RH
}

export const Plugin = <Tools extends Record<string, Tool.Any>, R = never, RH = never>(options: {
  readonly id?: PluginId | string
  readonly name: string
  readonly toolkit?: Toolkit.Toolkit<Tools>
  readonly handlers?: Layer.Layer<Tool.HandlersFor<Tools>, never, R>
  readonly hooks?: Layer.Layer<AgentHooks, never, AgentHooks | NoInfer<R> | RH>
  readonly models?: ReadonlyArray<ModelSpec<never, R>>
  readonly skills?: ReadonlyArray<Skill>
  readonly systemPrompt?: string
}): Plugin<R, RH> => {
  /* SAFETY: The constructor erases the concrete toolkit Tools parameter; R and RH
   * stay on handlers, hooks, and models. */
  return {
    ...options,
    id: options.id !== undefined ? PluginId.make(options.id) : PluginId.make(options.name),
  } as Plugin<R, RH>
}

/** Structural view that drops `any` from plugin Layer/ModelSpec channels. */
type PluginView = {
  readonly toolkit?: Toolkit.Any | undefined
  readonly handlers?: object | undefined
  readonly hooks?: object | undefined
  readonly models?:
    | ReadonlyArray<{
        readonly id: string
        readonly provider: string
        readonly description?: string | undefined
        readonly layer: object
      }>
    | undefined
  readonly skills?: ReadonlyArray<Skill> | undefined
  readonly systemPrompt?: string | undefined
}

interface PluginLayerValue {}

const asHandlerLayer = <R>(layer: PluginLayerValue): Layer.Layer<never, never, R> => {
  /* SAFETY: Plugin handlers are Layer values; R is recovered from the plugin list. */
  return layer as Layer.Layer<never, never, R>
}

const asHookLayer = (layer: PluginLayerValue): Layer.Layer<AgentHooks, never, AgentHooks> => {
  /* SAFETY: Plugin hooks are AgentHooks layers; the view erases extra R.
   * AgentPlugins provides AgentContext to the composed waterfall, so hook
   * stages may require it even though it is erased here. */
  return layer as Layer.Layer<AgentHooks, never, AgentHooks>
}

const asModelSpec = (spec: {
  readonly id: string
  readonly provider: string
  readonly description?: string | undefined
  readonly layer: object
}): ModelSpec<never, never> => {
  /* SAFETY: The view only erases the model layer's requirement channel; each
   * plugin supplies a concrete Layer at registration time. */
  return {
    id: spec.id,
    provider: spec.provider,
    ...(spec.description === undefined ? undefined : { description: spec.description }),
    layer: spec.layer as ModelSpec<never, never>["layer"],
  }
}

export type PluginRequirements<Plugins extends ReadonlyArray<Plugin<any, any>>> =
  Plugins[number] extends Plugin<infer R, infer RH> ? R | RH : never

export const AgentPlugins = <const Plugins extends ReadonlyArray<Plugin<any>>>(
  plugins: Plugins,
  options?: { readonly systemPrompt?: string | undefined },
): Layer.Layer<
  Agent,
  never,
  SessionJournal | Crypto.Crypto | Exclude<PluginRequirements<Plugins>, AgentContext>
> => {
  const views: ReadonlyArray<PluginView> = plugins
  const toolkit = Toolkit.merge(
    ...views.flatMap((plugin) => (plugin.toolkit === undefined ? [] : [plugin.toolkit])),
  )
  const handlers = views.flatMap((plugin) =>
    plugin.handlers === undefined
      ? []
      : [asHandlerLayer<PluginRequirements<Plugins>>(plugin.handlers)],
  )
  const models = views.flatMap((plugin) => (plugin.models ?? []).map(asModelSpec))
  const skills = views.flatMap((plugin) => plugin.skills ?? [])
  const systemPrompt = [options?.systemPrompt, ...views.map((plugin) => plugin.systemPrompt)]
    .filter((text): text is string => text !== undefined && text !== "")
    .join("\n\n")

  // Waterfall the hook layers outermost-first over the no-op base.
  const hooks = views.reduceRight(
    (downstream: Layer.Layer<AgentHooks>, plugin) =>
      plugin.hooks === undefined
        ? downstream
        : asHookLayer(plugin.hooks).pipe(Layer.provide(downstream)),
    layerNoop,
  )

  // The registry is built with static contributions (prompt, models, skills)
  // registered upon acquisition, and provided into the handlers, hooks, and
  // agent live layer.
  const registry = Layer.effect(
    AgentContext,
    Effect.gen(function* () {
      const context = yield* makeAgentContext()
      if (systemPrompt !== "") {
        yield* Effect.asVoid(context.registerPromptSection(systemPrompt))
      }
      yield* Effect.forEach(models, (spec) => Effect.asVoid(context.registerModel(spec)), {
        discard: true,
      })
      yield* Effect.forEach(skills, (skill) => Effect.asVoid(context.registerSkill(skill)), {
        discard: true,
      })
      return context
    }),
  )

  /* SAFETY: Crypto stays caller-provided so platform packages can substitute it;
   * the public type keeps SessionJournal plus each plugin's R/RH. AgentContext
   * requirements are satisfied by the provided registry, never the caller. */
  return (
    // oxlint-disable-next-line effecttsgo/unsafe-effect-type-assertion -- Crypto is supplied by the caller, not this layer
    Layer.unwrap(Effect.map(toolkit, (withHandler) => AgentLive(withHandler))).pipe(
      Layer.provide([
        registry,
        hooks.pipe(Layer.provide(registry)),
        ...handlers.map((handler) => handler.pipe(Layer.provide(registry))),
      ]),
    ) as Layer.Layer<
      Agent,
      never,
      SessionJournal | Crypto.Crypto | Exclude<PluginRequirements<Plugins>, AgentContext>
    >
  )
}
