import { Context, Effect, Exit, Layer, Option, Schema, Scope, SynchronizedRef } from "effect"
import { AiError, LanguageModel } from "effect/unstable/ai"
import type * as Tool from "effect/unstable/ai/Tool"

import { hooksNoop, type AgentHooksInterface } from "./AgentHooks.ts"
import { ModelNotFound, type ModelAd, type ModelSpec } from "./ModelCatalog.ts"
import { ModelId } from "./ModelId.ts"
import { PluginId } from "./PluginId.ts"
import type { ErasedToolkit } from "./runStep.ts"
import type { Skill } from "./Skills.ts"

export type Disposer = Effect.Effect<void>

export type ConflictPolicy = "reject" | "replace" | "stack"

export class RegistrationConflict extends Schema.TaggedErrorClass<RegistrationConflict>()(
  "RegistrationConflict",
  {
    kind: Schema.Literals(["tool", "model", "skill", "prompt", "hook"]),
    name: Schema.String,
    existingPluginId: Schema.optional(PluginId),
    newPluginId: Schema.optional(PluginId),
    message: Schema.String,
  },
) {}

export type RegistrationError = RegistrationConflict

/** Optional binding and policy for a registration. */
export type RegistrationOptions = {
  readonly scope?: Scope.Scope | undefined
  readonly pluginId?: PluginId | string | undefined
  readonly conflictPolicy?: ConflictPolicy | undefined
}

/** Constructor options for the registry. */
export type AgentContextOptions = {
  /** Base prompt prepended to every registered section. */
  readonly systemPrompt?: string | undefined
  readonly defaultConflictPolicy?:
    | Partial<Record<"tool" | "model" | "skill" | "prompt" | "hook", ConflictPolicy>>
    | undefined
}

export type ToolRegistration = {
  readonly identity: object
  readonly tool: Tool.Any
  readonly toolkit: ErasedToolkit
  readonly pluginId?: PluginId | undefined
  readonly conflictPolicy?: ConflictPolicy | undefined
}

export type ModelRegistration = {
  readonly identity: object
  readonly ad: ModelAd
  readonly model: LanguageModel.Service
  readonly pluginId?: PluginId | undefined
  readonly conflictPolicy?: ConflictPolicy | undefined
}

export type SkillRegistration = {
  readonly identity: object
  readonly skill: Skill
  readonly pluginId?: PluginId | undefined
  readonly conflictPolicy?: ConflictPolicy | undefined
}

export type PromptRegistration = {
  readonly identity: object
  readonly text: string
  readonly pluginId?: PluginId | undefined
  readonly conflictPolicy?: ConflictPolicy | undefined
}

export type HookRegistration = {
  readonly identity: object
  readonly hook: (downstream: AgentHooksInterface) => Effect.Effect<AgentHooksInterface>
  readonly pluginId?: PluginId | undefined
  readonly conflictPolicy?: ConflictPolicy | undefined
}

export interface RegistryState {
  readonly version: number
  readonly tools: ReadonlyArray<ToolRegistration>
  readonly models: ReadonlyArray<ModelRegistration>
  readonly skills: ReadonlyArray<SkillRegistration>
  readonly promptSections: ReadonlyArray<PromptRegistration>
  readonly hooks: ReadonlyArray<HookRegistration>
}

export interface CapabilitySnapshot {
  readonly version: number
  readonly toolkit: ErasedToolkit
  readonly tools: ReadonlyArray<Tool.Any>
  readonly models: ReadonlyArray<ModelAd>
  readonly modelServices: ReadonlyMap<ModelId, LanguageModel.Service>
  readonly defaultModelId: Option.Option<ModelId>
  readonly skills: ReadonlyArray<Skill>
  readonly promptSections: ReadonlyArray<string>
  readonly systemPrompt: string
  readonly hooks: AgentHooksInterface
  readonly resolveModel: (
    modelId: ModelId | string | undefined,
  ) => Effect.Effect<LanguageModel.Service, ModelNotFound>
}

export class AgentContext extends Context.Service<
  AgentContext,
  {
    /** Take an atomic snapshot of the entire capability registry at this moment in time. */
    readonly snapshot: Effect.Effect<CapabilitySnapshot>
    /** Current registry generation version. Increments monotonically on registration/deregistration. */
    readonly version: Effect.Effect<number>
    /** The current tool view. Later registrations shadow earlier ones by name. */
    readonly toolkit: Effect.Effect<ErasedToolkit>
    readonly tools: Effect.Effect<Record<string, Tool.Any>>
    readonly skills: Effect.Effect<ReadonlyArray<Skill>>
    readonly systemPrompt: Effect.Effect<string>
    /** Sections registered after the run begins, to journal before the next request. */
    readonly promptSections: Effect.Effect<ReadonlyArray<string>>
    readonly models: Effect.Effect<ReadonlyArray<ModelAd>>
    readonly defaultModelId: Effect.Effect<ModelId | string>
    readonly resolveModel: (
      modelId: ModelId | string | undefined,
    ) => Effect.Effect<LanguageModel.Service, ModelNotFound>
    readonly hooks: Effect.Effect<AgentHooksInterface>
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
    ) => Effect.Effect<Disposer, RegistrationConflict>
    readonly registerPromptSection: (
      text: string,
      options?: RegistrationOptions,
    ) => Effect.Effect<Disposer, RegistrationConflict>
    readonly registerModel: <E, R>(
      spec: ModelSpec<E, R>,
      options?: RegistrationOptions,
    ) => Effect.Effect<Disposer, E | RegistrationConflict, R>
    readonly registerSkill: (
      skill: Skill,
      options?: RegistrationOptions,
    ) => Effect.Effect<Disposer, RegistrationConflict>
    readonly registerHook: <E = never, R = never>(
      hook: (downstream: AgentHooksInterface) => Effect.Effect<AgentHooksInterface, E, R>,
      options?: RegistrationOptions,
    ) => Effect.Effect<Disposer, E | RegistrationConflict, R>
  }
>()("roop/AgentContext") {}

const latestBy = <A>(entries: ReadonlyArray<A>, key: (entry: A) => string): ReadonlyArray<A> => {
  const resolved = new Map<string, A>()
  for (const entry of entries) resolved.set(key(entry), entry)
  return [...resolved.values()]
}

const defaultConflictPolicyFor = (
  kind: "tool" | "model" | "skill" | "prompt" | "hook",
  custom?: Partial<Record<"tool" | "model" | "skill" | "prompt" | "hook", ConflictPolicy>>,
): ConflictPolicy => {
  if (custom?.[kind] !== undefined) return custom[kind]!
  switch (kind) {
    case "tool":
    case "model":
    case "skill":
      return "reject"
    case "prompt":
    case "hook":
      return "stack"
  }
}

const composeHooks = (hooks: ReadonlyArray<HookRegistration>): AgentHooksInterface => {
  let current: AgentHooksInterface = hooksNoop
  for (let i = hooks.length - 1; i >= 0; i--) {
    const reg = hooks[i]!
    const downstream = current
    current = {
      preStep: (ctx) => Effect.flatMap(reg.hook(downstream), (h) => h.preStep(ctx)),
      beforeRequest: (ctx, req) =>
        Effect.flatMap(reg.hook(downstream), (h) => h.beforeRequest(ctx, req)),
      beforeToolExecute: (ctx, call) =>
        Effect.flatMap(reg.hook(downstream), (h) => h.beforeToolExecute(ctx, call)),
      afterToolExecute: (ctx, call, isFailure) =>
        Effect.flatMap(reg.hook(downstream), (h) => h.afterToolExecute(ctx, call, isFailure)),
      turnStopping: (ctx, stop) =>
        Effect.flatMap(reg.hook(downstream), (h) => h.turnStopping(ctx, stop)),
    }
  }
  return current
}

const deriveSnapshot = (state: RegistryState, basePrompt: string): CapabilitySnapshot => {
  const version = state.version
  const uniqueTools = latestBy(state.tools, (entry) => entry.tool.name)
  const toolsRecord: Record<string, Tool.Any> = Object.fromEntries(
    uniqueTools.map((entry) => [entry.tool.name, entry.tool]),
  )
  const toolsArray: ReadonlyArray<Tool.Any> = uniqueTools.map((entry) => entry.tool)
  const byName = Object.fromEntries(uniqueTools.map((entry) => [entry.tool.name, entry]))
  const handle: ErasedToolkit["handle"] = (name, params) => {
    const entry = byName[name]
    return entry === undefined
      ? Effect.fail(
          AiError.make({
            module: "AgentContext",
            method: `${name}.handle`,
            reason: new AiError.ToolNotFoundError({
              toolName: name,
              availableTools: Object.keys(byName),
            }),
          }),
        )
      : entry.toolkit.handle(name, params)
  }
  const toolkit: ErasedToolkit = {
    tools: toolsRecord,
    handle,
  }

  const uniqueModels = latestBy(state.models, (entry) => String(entry.ad.id))
  const modelAds = uniqueModels.map((entry) => entry.ad)
  const modelServices = new Map<ModelId, LanguageModel.Service>(
    uniqueModels.map((entry) => [entry.ad.id, entry.model]),
  )
  const lastModel = modelAds.at(-1)
  const defaultModelId = lastModel !== undefined ? Option.some(lastModel.id) : Option.none()

  const resolveModel = (
    modelId: ModelId | string | undefined,
  ): Effect.Effect<LanguageModel.Service, ModelNotFound> => {
    if (modelId === undefined) {
      const last = uniqueModels.at(-1)
      return last === undefined
        ? Effect.fail(new ModelNotFound({ modelId: ModelId.make("") }))
        : Effect.succeed(last.model)
    }
    const resolvedId = ModelId.make(modelId)
    const found = modelServices.get(resolvedId)
    return found === undefined
      ? Effect.fail(new ModelNotFound({ modelId: resolvedId }))
      : Effect.succeed(found)
  }

  const uniqueSkills = latestBy(state.skills, (entry) => entry.skill.id).map((entry) => entry.skill)
  const promptSections = state.promptSections.map((entry) => entry.text)
  const systemPrompt = [basePrompt, ...promptSections].filter((text) => text !== "").join("\n\n")
  const hooks = composeHooks(state.hooks)

  return {
    version,
    toolkit,
    tools: toolsArray,
    models: modelAds,
    modelServices,
    defaultModelId,
    skills: uniqueSkills,
    promptSections,
    systemPrompt,
    hooks,
    resolveModel,
  }
}

/**
 * Agent-owned, scope-bound capability registry. Backed by a single SynchronizedRef
 * to ensure atomic snapshots and serialized state transitions. Every contribution —
 * static plugin composition included — enters through the same `register*` calls.
 */
export const make = (
  options?: AgentContextOptions,
): Effect.Effect<AgentContext["Service"], never, Scope.Scope> =>
  Effect.gen(function* () {
    const basePrompt = options?.systemPrompt ?? ""
    const stateRef = yield* SynchronizedRef.make<RegistryState>({
      version: 0,
      tools: [],
      models: [],
      skills: [],
      promptSections: [],
      hooks: [],
    })

    // The agent-owned scope: closed when the layer's own scope closes, which
    // unwinds every registration that bound to it (including mid-run ones).
    const agentScope = yield* Scope.make()
    yield* Effect.addFinalizer(() => Scope.close(agentScope, Exit.void))

    const snapshot = SynchronizedRef.get(stateRef).pipe(
      Effect.map((state) => deriveSnapshot(state, basePrompt)),
    )

    const registerTool = (
      tool: Tool.Any,
      handlers: ErasedToolkit,
      registration?: RegistrationOptions,
    ): Effect.Effect<Disposer, RegistrationConflict> =>
      Effect.suspend(() => {
        const targetScope = registration?.scope ?? agentScope
        const policy =
          registration?.conflictPolicy ??
          defaultConflictPolicyFor("tool", options?.defaultConflictPolicy)
        const pluginId =
          registration?.pluginId !== undefined ? PluginId.make(registration.pluginId) : undefined
        const identity = {}

        return SynchronizedRef.modifyEffect(stateRef, (state) => {
          const existing = state.tools.find((entry) => entry.tool.name === tool.name)
          if (existing !== undefined && policy === "reject") {
            return Effect.fail(
              new RegistrationConflict({
                kind: "tool",
                name: tool.name,
                existingPluginId: existing.pluginId,
                newPluginId: pluginId,
                message: `Tool '${tool.name}' is already registered${
                  existing.pluginId ? ` by plugin '${existing.pluginId}'` : ""
                }`,
              }),
            )
          }
          const entry: ToolRegistration = {
            identity,
            tool,
            toolkit: handlers,
            pluginId,
            conflictPolicy: policy,
          }
          const nextState: RegistryState = {
            ...state,
            version: state.version + 1,
            tools: [...state.tools, entry],
          }
          const disp: Disposer = SynchronizedRef.update(stateRef, (s) => ({
            ...s,
            version: s.version + 1,
            tools: s.tools.filter((t) => t.identity !== identity),
          }))
          return Effect.succeed([disp, nextState] as const)
        }).pipe(
          Effect.tap((dispose) =>
            Effect.addFinalizer(() => dispose).pipe(
              Effect.provideService(Scope.Scope, targetScope),
            ),
          ),
        )
      })

    const registerPromptSection = (
      text: string,
      registration?: RegistrationOptions,
    ): Effect.Effect<Disposer, RegistrationConflict> =>
      Effect.suspend(() => {
        const targetScope = registration?.scope ?? agentScope
        const policy =
          registration?.conflictPolicy ??
          defaultConflictPolicyFor("prompt", options?.defaultConflictPolicy)
        const pluginId =
          registration?.pluginId !== undefined ? PluginId.make(registration.pluginId) : undefined
        const identity = {}

        return SynchronizedRef.modifyEffect(stateRef, (state) => {
          const existing = state.promptSections.find((entry) => entry.text === text)
          if (existing !== undefined && policy === "reject") {
            return Effect.fail(
              new RegistrationConflict({
                kind: "prompt",
                name: text,
                existingPluginId: existing.pluginId,
                newPluginId: pluginId,
                message: `Prompt section already registered${
                  existing.pluginId ? ` by plugin '${existing.pluginId}'` : ""
                }`,
              }),
            )
          }
          const entry: PromptRegistration = {
            identity,
            text,
            pluginId,
            conflictPolicy: policy,
          }
          const nextState: RegistryState = {
            ...state,
            version: state.version + 1,
            promptSections: [...state.promptSections, entry],
          }
          const disp: Disposer = SynchronizedRef.update(stateRef, (s) => ({
            ...s,
            version: s.version + 1,
            promptSections: s.promptSections.filter((p) => p.identity !== identity),
          }))
          return Effect.succeed([disp, nextState] as const)
        }).pipe(
          Effect.tap((dispose) =>
            Effect.addFinalizer(() => dispose).pipe(
              Effect.provideService(Scope.Scope, targetScope),
            ),
          ),
        )
      })

    const registerModel = <E, R>(
      spec: ModelSpec<E, R>,
      registration?: RegistrationOptions,
    ): Effect.Effect<Disposer, E | RegistrationConflict, R> =>
      Effect.suspend(() => {
        const targetScope = registration?.scope ?? agentScope
        const policy =
          registration?.conflictPolicy ??
          defaultConflictPolicyFor("model", options?.defaultConflictPolicy)
        const pluginId =
          registration?.pluginId !== undefined ? PluginId.make(registration.pluginId) : undefined
        const modelId = ModelId.make(spec.id)
        const identity = {}

        return Layer.buildWithScope(spec.layer, targetScope).pipe(
          Effect.flatMap((built) => {
            const modelService = Context.get(built, LanguageModel.LanguageModel)
            return SynchronizedRef.modifyEffect(stateRef, (state) => {
              const existing = state.models.find((entry) => entry.ad.id === modelId)
              if (existing !== undefined && policy === "reject") {
                return Effect.fail(
                  new RegistrationConflict({
                    kind: "model",
                    name: String(modelId),
                    existingPluginId: existing.pluginId,
                    newPluginId: pluginId,
                    message: `Model '${modelId}' is already registered${
                      existing.pluginId ? ` by plugin '${existing.pluginId}'` : ""
                    }`,
                  }),
                )
              }
              const entry: ModelRegistration = {
                identity,
                ad: {
                  id: modelId,
                  provider: spec.provider,
                  ...(spec.description === undefined
                    ? undefined
                    : { description: spec.description }),
                },
                model: modelService,
                pluginId,
                conflictPolicy: policy,
              }
              const nextState: RegistryState = {
                ...state,
                version: state.version + 1,
                models: [...state.models, entry],
              }
              const disp: Disposer = SynchronizedRef.update(stateRef, (s) => ({
                ...s,
                version: s.version + 1,
                models: s.models.filter((m) => m.identity !== identity),
              }))
              return Effect.succeed([disp, nextState] as const)
            })
          }),
          Effect.tap((dispose) =>
            Effect.addFinalizer(() => dispose).pipe(
              Effect.provideService(Scope.Scope, targetScope),
            ),
          ),
        )
      })

    const registerSkill = (
      skill: Skill,
      registration?: RegistrationOptions,
    ): Effect.Effect<Disposer, RegistrationConflict> =>
      Effect.suspend(() => {
        const targetScope = registration?.scope ?? agentScope
        const policy =
          registration?.conflictPolicy ??
          defaultConflictPolicyFor("skill", options?.defaultConflictPolicy)
        const pluginId =
          registration?.pluginId !== undefined ? PluginId.make(registration.pluginId) : undefined
        const identity = {}

        return SynchronizedRef.modifyEffect(stateRef, (state) => {
          const existing = state.skills.find((entry) => entry.skill.id === skill.id)
          if (existing !== undefined && policy === "reject") {
            return Effect.fail(
              new RegistrationConflict({
                kind: "skill",
                name: skill.id,
                existingPluginId: existing.pluginId,
                newPluginId: pluginId,
                message: `Skill '${skill.id}' is already registered${
                  existing.pluginId ? ` by plugin '${existing.pluginId}'` : ""
                }`,
              }),
            )
          }
          const entry: SkillRegistration = {
            identity,
            skill,
            pluginId,
            conflictPolicy: policy,
          }
          const nextState: RegistryState = {
            ...state,
            version: state.version + 1,
            skills: [...state.skills, entry],
          }
          const disp: Disposer = SynchronizedRef.update(stateRef, (s) => ({
            ...s,
            version: s.version + 1,
            skills: s.skills.filter((s) => s.identity !== identity),
          }))
          return Effect.succeed([disp, nextState] as const)
        }).pipe(
          Effect.tap((dispose) =>
            Effect.addFinalizer(() => dispose).pipe(
              Effect.provideService(Scope.Scope, targetScope),
            ),
          ),
        )
      })

    const registerHook = <E = never, R = never>(
      hook: (downstream: AgentHooksInterface) => Effect.Effect<AgentHooksInterface, E, R>,
      registration?: RegistrationOptions,
    ): Effect.Effect<Disposer, E | RegistrationConflict, R> =>
      Effect.suspend(() => {
        const targetScope = registration?.scope ?? agentScope
        const policy =
          registration?.conflictPolicy ??
          defaultConflictPolicyFor("hook", options?.defaultConflictPolicy)
        const pluginId =
          registration?.pluginId !== undefined ? PluginId.make(registration.pluginId) : undefined
        const identity = {}

        return Effect.context<R>().pipe(
          Effect.flatMap((env) => {
            const closedHook = (
              downstream: AgentHooksInterface,
            ): Effect.Effect<AgentHooksInterface> =>
              Effect.orDie(Effect.provide(hook(downstream), env))

            return SynchronizedRef.modifyEffect(stateRef, (state) => {
              const entry: HookRegistration = {
                identity,
                hook: closedHook,
                pluginId,
                conflictPolicy: policy,
              }
              const nextState: RegistryState = {
                ...state,
                version: state.version + 1,
                hooks: [...state.hooks, entry],
              }
              const disp: Disposer = SynchronizedRef.update(stateRef, (s) => ({
                ...s,
                version: s.version + 1,
                hooks: s.hooks.filter((h) => h.identity !== identity),
              }))
              return Effect.succeed([disp, nextState] as const)
            })
          }),
          Effect.tap((dispose) =>
            Effect.addFinalizer(() => dispose).pipe(
              Effect.provideService(Scope.Scope, targetScope),
            ),
          ),
        )
      })

    return AgentContext.of({
      snapshot,
      version: SynchronizedRef.get(stateRef).pipe(Effect.map((s) => s.version)),
      toolkit: snapshot.pipe(Effect.map((s) => s.toolkit)),
      tools: snapshot.pipe(Effect.map((s) => s.toolkit.tools)),
      skills: snapshot.pipe(Effect.map((s) => s.skills)),
      systemPrompt: snapshot.pipe(Effect.map((s) => s.systemPrompt)),
      promptSections: snapshot.pipe(Effect.map((s) => s.promptSections)),
      models: snapshot.pipe(Effect.map((s) => s.models)),
      defaultModelId: snapshot.pipe(
        Effect.map((s) =>
          s.defaultModelId._tag === "Some" ? s.defaultModelId.value : ModelId.make(""),
        ),
      ),
      resolveModel: (modelId) =>
        SynchronizedRef.get(stateRef).pipe(
          Effect.flatMap((state) => deriveSnapshot(state, basePrompt).resolveModel(modelId)),
        ),
      hooks: snapshot.pipe(Effect.map((s) => s.hooks)),
      registerTool,
      registerPromptSection,
      registerModel,
      registerSkill,
      registerHook,
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
  readonly conflictPolicy?: ConflictPolicy | undefined
}): Layer.Layer<never, RegistrationConflict, AgentContext> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const context = yield* AgentContext
      const systemPrompt = options.systemPrompt ?? ""
      if (systemPrompt !== "") {
        yield* Effect.asVoid(
          context.registerPromptSection(systemPrompt, {
            conflictPolicy: options.conflictPolicy ?? "stack",
          }),
        )
      }
      for (const spec of options.models ?? []) {
        yield* Effect.asVoid(
          context.registerModel(spec, {
            conflictPolicy: options.conflictPolicy ?? "reject",
          }),
        )
      }
      for (const skill of options.skills ?? []) {
        yield* Effect.asVoid(
          context.registerSkill(skill, {
            conflictPolicy: options.conflictPolicy ?? "reject",
          }),
        )
      }
    }),
  )

/**
 * Build a registry layer. Each call returns a fresh layer, so sibling agents
 * (e.g. a subagent and its parent) never share registry state through layer
 * memoization.
 */
export const AgentContextLive = (options?: AgentContextOptions): Layer.Layer<AgentContext> =>
  Layer.effect(AgentContext, make(options))
