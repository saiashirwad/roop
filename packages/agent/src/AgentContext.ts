import { Context, Effect, Exit, Layer, Ref, Scope } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import type * as Tool from "effect/unstable/ai/Tool"

import type { ErasedToolkit } from "./agentLoop.ts"
import { ModelNotFound, type ModelAd, type ModelSpec } from "./ModelCatalog.ts"
import type { Skill } from "./Skills.ts"

export type Disposer = Effect.Effect<void>

/** Optional binding for a registration; defaults to the agent's own scope. */
export type RegistrationOptions = {
  readonly scope?: Scope.Scope | undefined
}

/** Constructor options for the registry. */
export type AgentContextOptions = {
  /** Base prompt prepended to every registered section. */
  readonly systemPrompt?: string | undefined
}

type ToolEntry = {
  readonly tool: Tool.Any
  readonly toolkit: ErasedToolkit
}

type ModelEntry = {
  readonly ad: ModelAd
  readonly model: LanguageModel.Service
}

export class AgentContext extends Context.Service<
  AgentContext,
  {
    /** The current tool view. Later registrations shadow earlier ones by name. */
    readonly toolkit: Effect.Effect<ErasedToolkit>
    readonly tools: Effect.Effect<Record<string, Tool.Any>>
    readonly skills: Effect.Effect<ReadonlyArray<Skill>>
    readonly systemPrompt: Effect.Effect<string>
    /** Sections registered after the run begins, to journal before the next request. */
    readonly promptSections: Effect.Effect<ReadonlyArray<string>>
    readonly models: Effect.Effect<ReadonlyArray<ModelAd>>
    readonly defaultModelId: Effect.Effect<string>
    readonly resolveModel: (
      modelId: string | undefined,
    ) => Effect.Effect<LanguageModel.Service, ModelNotFound>
    /**
     * Register a capability. Each call returns a disposer that removes just
     * that registration. Registrations bind to the agent's own scope, which
     * closes with the agent layer (so subagent contributions unwind when the
     * subagent completes); pass an explicit `scope` to bind elsewhere.
     */
    readonly registerTool: (
      tool: Tool.Any,
      handlers: ErasedToolkit,
      options?: RegistrationOptions,
    ) => Effect.Effect<Disposer>
    readonly registerPromptSection: (
      text: string,
      options?: RegistrationOptions,
    ) => Effect.Effect<Disposer>
    readonly registerModel: <E, R>(
      spec: ModelSpec<E, R>,
      options?: RegistrationOptions,
    ) => Effect.Effect<Disposer, E, R>
    readonly registerSkill: (skill: Skill, options?: RegistrationOptions) => Effect.Effect<Disposer>
  }
>()("roop/AgentContext") {}

const scoped = <A>(ref: Ref.Ref<ReadonlyArray<A>>, value: A, scope: Scope.Scope) =>
  Effect.suspend(() => {
    let disposed = false
    const dispose = Effect.suspend(() => {
      if (disposed) return Effect.void
      disposed = true
      return Ref.update(ref, (entries) => entries.filter((entry) => entry !== value))
    })
    return Ref.update(ref, (entries) => [...entries, value]).pipe(
      Effect.andThen(Effect.addFinalizer(() => dispose)),
      Effect.as(dispose),
      Effect.provideService(Scope.Scope, scope),
    )
  })

const latestBy = <A>(entries: ReadonlyArray<A>, key: (entry: A) => string): ReadonlyArray<A> => {
  const resolved = new Map<string, A>()
  for (const entry of entries) resolved.set(key(entry), entry)
  return [...resolved.values()]
}

/**
 * Agent-owned, scope-bound capability registry. This is a service rather than
 * a value because registrations are mutable resources with a real lifecycle.
 * Every contribution — static plugin composition included — enters through
 * the same `register*` calls; there is no parallel static path.
 */

export const make = (
  options?: AgentContextOptions,
): Effect.Effect<AgentContext["Service"], never, Scope.Scope> =>
  Effect.gen(function* () {
    const tools = yield* Ref.make<ReadonlyArray<ToolEntry>>([])
    const promptSections = yield* Ref.make<ReadonlyArray<string>>([])
    const models = yield* Ref.make<ReadonlyArray<ModelEntry>>([])
    const skills = yield* Ref.make<ReadonlyArray<Skill>>([])
    const basePrompt = options?.systemPrompt ?? ""
    // The agent-owned scope: closed when the layer's own scope closes, which
    // unwinds every registration that bound to it (including mid-run ones).
    const scope = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))

    const resolvedTools = () =>
      Ref.get(tools).pipe(Effect.map((entries) => latestBy(entries, (entry) => entry.tool.name)))

    const allModels = () =>
      Ref.get(models).pipe(
        Effect.map((entries) =>
          latestBy(
            entries.map((entry) => entry.ad),
            (entry) => entry.id,
          ),
        ),
      )

    return AgentContext.of({
      toolkit: resolvedTools().pipe(
        Effect.map((entries) => {
          const byName = Object.fromEntries(entries.map((entry) => [entry.tool.name, entry]))
          return {
            tools: Object.fromEntries(entries.map((entry) => [entry.tool.name, entry.tool])),
            /* SAFETY: Dynamic tools share the erased handle contract of ErasedToolkit. */
            handle: ((name: string, params: Tool.Parameters<Tool.Any>) =>
              byName[name]!.toolkit.handle(name, params)) as ErasedToolkit["handle"],
          }
        }),
      ),
      tools: resolvedTools().pipe(
        Effect.map((entries) =>
          Object.fromEntries(entries.map((entry) => [entry.tool.name, entry.tool])),
        ),
      ),
      skills: Ref.get(skills).pipe(Effect.map((entries) => latestBy(entries, (entry) => entry.id))),
      systemPrompt: Ref.get(promptSections).pipe(
        Effect.map((sections) =>
          [basePrompt, ...sections].filter((text) => text !== "").join("\n\n"),
        ),
      ),
      promptSections: Ref.get(promptSections),
      models: allModels(),
      defaultModelId: allModels().pipe(Effect.map((entries) => entries[0]?.id ?? "")),
      resolveModel: (modelId) =>
        Ref.get(models).pipe(
          Effect.flatMap((registered) => {
            if (modelId === undefined) {
              const first = registered[0]
              return first === undefined
                ? Effect.fail(new ModelNotFound({ modelId: "" }))
                : Effect.succeed(first.model)
            }
            const entry = registered.findLast((candidate) => candidate.ad.id === modelId)
            return entry === undefined
              ? Effect.fail(new ModelNotFound({ modelId }))
              : Effect.succeed(entry.model)
          }),
        ),
      registerTool: (tool, handlers, registration) =>
        scoped(tools, { tool, toolkit: handlers }, registration?.scope ?? scope),
      registerPromptSection: (text, registration) =>
        scoped(promptSections, text, registration?.scope ?? scope),
      registerModel: (spec, registration) =>
        Effect.suspend(() => {
          const target = registration?.scope ?? scope
          return Effect.gen(function* () {
            const built = yield* Layer.buildWithScope(spec.layer, target)
            const entry: ModelEntry = {
              ad: {
                id: spec.id,
                provider: spec.provider,
                ...(spec.description === undefined ? undefined : { description: spec.description }),
              },
              model: Context.get(built, LanguageModel.LanguageModel),
            }
            return yield* scoped(models, entry, target)
          })
        }),
      registerSkill: (skill, registration) => scoped(skills, skill, registration?.scope ?? scope),
    })
  })

/**
 * Register static contributions (a joined prompt, models, skills) as ordinary
 * registry calls, so static plugin composition and runtime registration are
 * one mechanism. Provide the registry into the returned layer.
 */
export const registerStatics = (options: {
  readonly systemPrompt?: string | undefined
  readonly models?: ReadonlyArray<ModelSpec<never, never>> | undefined
  readonly skills?: ReadonlyArray<Skill> | undefined
}): Layer.Layer<never, never, AgentContext> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const context = yield* AgentContext
      const systemPrompt = options.systemPrompt ?? ""
      if (systemPrompt !== "") {
        yield* Effect.asVoid(context.registerPromptSection(systemPrompt))
      }
      yield* Effect.forEach(
        options.models ?? [],
        (spec) => Effect.asVoid(context.registerModel(spec)),
        {
          discard: true,
        },
      )
      yield* Effect.forEach(
        options.skills ?? [],
        (skill) => Effect.asVoid(context.registerSkill(skill)),
        { discard: true },
      )
    }),
  )

/**
 * Build a registry layer. Each call returns a fresh layer, so sibling agents
 * (e.g. a subagent and its parent) never share registry state through layer
 * memoization.
 */
export const AgentContextLive = (options?: AgentContextOptions): Layer.Layer<AgentContext> =>
  Layer.effect(AgentContext, make(options))
