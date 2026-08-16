import { Context, Crypto, Effect, Layer, Scope } from "effect"
import type { Toolkit } from "effect/unstable/ai"
import type * as Tool from "effect/unstable/ai/Tool"

import { AgentLive, type Agent } from "./Agent.ts"
import {
  AgentContext,
  AgentContextLive,
  type ConflictPolicy,
} from "./AgentContext.ts"
import { AgentHooks, layerNoop } from "./AgentHooks.ts"
import type { ModelSpec } from "./ModelCatalog.ts"
import { PluginId } from "./PluginId.ts"
import { RunRegistryLive } from "./RunRegistry.ts"
import { eraseToolkit } from "./runStep.ts"
import type { SessionJournal } from "./SessionJournal.ts"
import type { Skill } from "./Skills.ts"

export type { ConflictPolicy, RegistrationConflict } from "./AgentContext.ts"

export interface Plugin<out R = never, out E = never, out RH = never> {
  readonly id: PluginId
  readonly name: string
  /** Internal installer; AgentPlugins supplies AgentContext and the hook base. */
  readonly install: Layer.Layer<never, never, AgentContext | AgentHooks | R | RH>
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
  readonly conflictPolicy?: ConflictPolicy | undefined
  readonly install?: Layer.Layer<never, E, AgentContext | R> | undefined
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

  /* SAFETY: The default installer satisfies the closed installer signature. */
  const defaultInstall = Layer.effectDiscard(
    Effect.gen(function* () {
      const context = yield* AgentContext
      const scope = yield* Scope.Scope

      // 1. Tool handlers
      if (options.toolkit !== undefined) {
        if (options.handlers !== undefined) {
          const handlersCtx = yield* Layer.buildWithScope(options.handlers, scope)
          const withHandler = yield* Effect.provide(
            options.toolkit,
            handlersCtx,
          )
          const erasedToolkit = eraseToolkit(withHandler)
          for (const tool of Object.values(withHandler.tools)) {
            yield* Effect.asVoid(
              context.registerTool(tool, erasedToolkit, {
                pluginId,
                conflictPolicy: options.conflictPolicy,
              }),
            )
          }
        }
      } else if (options.handlers !== undefined) {
        yield* Layer.buildWithScope(options.handlers, scope)
      }

      // 2. Models
      if (options.models !== undefined) {
        for (const spec of options.models) {
          yield* Effect.asVoid(
            context.registerModel(spec, {
              pluginId,
              conflictPolicy: options.conflictPolicy,
            }),
          )
        }
      }

      // 3. Skills
      if (options.skills !== undefined) {
        for (const skill of options.skills) {
          yield* Effect.asVoid(
            context.registerSkill(skill, {
              pluginId,
              conflictPolicy: options.conflictPolicy,
            }),
          )
        }
      }

      // 4. Prompt sections & system prompt
      const sections = [options.systemPrompt, ...(options.promptSections ?? [])].filter(
        (text): text is string => text !== undefined && text !== "",
      )
      for (const section of sections) {
        yield* Effect.asVoid(
          context.registerPromptSection(section, {
            pluginId,
            conflictPolicy: options.conflictPolicy ?? "stack",
          }),
        )
      }

      // 5. Hooks
      if (options.hooks !== undefined) {
        const hookLayer = options.hooks
        yield* Effect.asVoid(
          context.registerHook(
            (downstream) =>
              Effect.gen(function* () {
                const hookScope = yield* Scope.make()
                const downstreamLayer = Layer.succeed(AgentHooks, downstream)
                const built = yield* Layer.buildWithScope(
                  hookLayer.pipe(Layer.provide(downstreamLayer)),
                  hookScope,
                )
                return Context.get(built, AgentHooks)
              }),
            {
              pluginId,
              conflictPolicy: options.conflictPolicy ?? "stack",
            },
          ),
        )
      }

      // 6. Custom install layer if provided
      if (options.install !== undefined) {
        yield* Layer.buildWithScope(options.install, scope)
      }
    }),
  )
  return {
    id: pluginId,
    name,
    install: Layer.orDie(defaultInstall),
  }
}

export const Plugin = Object.assign(make, {
  make,
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
    readonly conflictPolicy?: ConflictPolicy | undefined
  },
): Layer.Layer<
  Agent,
  never,
  SessionJournal | Crypto.Crypto | Exclude<PluginRequirements<Plugins>, AgentContext>
> => {
  const registry = AgentContextLive({
    systemPrompt: options?.systemPrompt,
    defaultConflictPolicy:
      options?.conflictPolicy !== undefined
        ? {
            tool: options.conflictPolicy,
            model: options.conflictPolicy,
            skill: options.conflictPolicy,
            prompt: options.conflictPolicy,
            hook: options.conflictPolicy,
          }
        : undefined,
  })

  const installAll = Layer.effectDiscard(
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const context = yield* AgentContext
      for (const plugin of plugins) {
        yield* Layer.buildWithScope(
          plugin.install.pipe(Layer.provide(Layer.succeed(AgentContext, context))),
          scope,
        )
      }
    }),
  )

  const registryWithPlugins = installAll.pipe(Layer.provide(layerNoop), Layer.provideMerge(registry))

  return Layer.fresh(AgentLive).pipe(
    Layer.orDie,
    Layer.provide(registryWithPlugins),
    Layer.provide(RunRegistryLive),
  )
}
/* oxlint-enable effecttsgo/any-unknown-in-error-context */
