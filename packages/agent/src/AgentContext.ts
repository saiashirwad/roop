import { Context, Effect, Layer, Ref, Scope } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import type * as Tool from "effect/unstable/ai/Tool"

import type { ErasedToolkit } from "./agentLoop.ts"
import { ModelCatalog, ModelNotFound, type ModelAd, type ModelSpec } from "./ModelCatalog.ts"
import { Skills, type Skill } from "./Skills.ts"

export type Disposer = Effect.Effect<void>

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
    readonly registerTool: (
      tool: Tool.Any,
      handlers: ErasedToolkit,
    ) => Effect.Effect<Disposer, never, Scope.Scope>
    readonly registerPromptSection: (text: string) => Effect.Effect<Disposer, never, Scope.Scope>
    readonly registerModel: <E, R>(
      spec: ModelSpec<E, R>,
    ) => Effect.Effect<Disposer, E, R | Scope.Scope>
    readonly registerSkill: (skill: Skill) => Effect.Effect<Disposer, never, Scope.Scope>
  }
>()("roop/AgentContext") {}

const scoped = <A>(ref: Ref.Ref<ReadonlyArray<A>>, value: A) =>
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
 */
export const make = (options?: {
  readonly systemPrompt?: string | undefined
}): Effect.Effect<AgentContext["Service"], never, ModelCatalog> =>
  Effect.gen(function* () {
    const catalog = yield* ModelCatalog
    const skillsOption = yield* Effect.serviceOption(Skills)
    const tools = yield* Ref.make<ReadonlyArray<ToolEntry>>([])
    const promptSections = yield* Ref.make<ReadonlyArray<string>>([])
    const models = yield* Ref.make<ReadonlyArray<ModelEntry>>([])
    const skills = yield* Ref.make<ReadonlyArray<Skill>>(
      skillsOption._tag === "Some" ? skillsOption.value.list : [],
    )
    const basePrompt = options?.systemPrompt ?? ""

    const resolvedTools = () =>
      Ref.get(tools).pipe(Effect.map((entries) => latestBy(entries, (entry) => entry.tool.name)))

    const allModels = () =>
      Effect.all([catalog.list, Ref.get(models)]).pipe(
        Effect.map(([base, registered]) =>
          latestBy([...base, ...registered.map((entry) => entry.ad)], (entry) => entry.id),
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
            const entry = [...registered].reverse().find((candidate) => candidate.ad.id === modelId)
            return entry === undefined ? catalog.resolve(modelId) : Effect.succeed(entry.model)
          }),
        ),
      registerTool: (tool, handlers) => scoped(tools, { tool, toolkit: handlers }),
      registerPromptSection: (text) => scoped(promptSections, text),
      registerModel: (spec) =>
        Effect.gen(function* () {
          const built = yield* Layer.build(spec.layer)
          const entry: ModelEntry = {
            ad: {
              id: spec.id,
              provider: spec.provider,
              ...(spec.description === undefined ? undefined : { description: spec.description }),
            },
            model: Context.get(built, LanguageModel.LanguageModel),
          }
          return yield* scoped(models, entry)
        }),
      registerSkill: (skill) => scoped(skills, skill),
    })
  })

export const AgentContextLive = (options?: {
  readonly systemPrompt?: string | undefined
}): Layer.Layer<AgentContext, never, ModelCatalog> => Layer.effect(AgentContext, make(options))
