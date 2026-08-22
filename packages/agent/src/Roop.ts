/* oxlint-disable anti-slop/no-chained-type-assertions, anti-slop/no-escape-hatch-assertions, anti-slop/require-safety-comment-for-type-assertion -- Roop composition layer merges multi-capability layers preserving precise typed requirements. */

import { Context, Effect, Layer } from "effect"
import { LanguageModel } from "effect/unstable/ai"

import { Journal, type JournalService } from "./Journal.ts"
import { JournalMemory } from "./JournalMemory.ts"
import {
  all as allMiddleware,
  layerEmpty as middlewareLayerEmpty,
  type Middleware,
  MiddlewareService,
} from "./Middleware.ts"
import { AgentRuntime, AgentRuntimeLive, type AgentRuntimeService } from "./Runtime.ts"

export interface RoopOptions<
  ModelR = never,
  ModelE = never,
  JournalR = never,
  JournalE = never,
  MwR = never,
  MwE = never,
> {
  readonly model: Layer.Layer<LanguageModel.LanguageModel, ModelE, ModelR> | LanguageModel.Service
  readonly journal?: Layer.Layer<Journal, JournalE, JournalR> | undefined
  readonly middleware?:
    | ReadonlyArray<Middleware<MwR, MwE>>
    | Layer.Layer<MiddlewareService, MwE, MwR>
    | undefined
}

export interface RoopService {
  readonly runtime: AgentRuntimeService
  readonly journal: JournalService
  readonly model: LanguageModel.Service
}

export class Roop extends Context.Service<Roop, RoopService>()("roop/Roop") {
  static readonly layer = <
    ModelR = never,
    ModelE = never,
    JournalR = never,
    JournalE = never,
    MwR = never,
    MwE = never,
  >(
    options: RoopOptions<ModelR, ModelE, JournalR, JournalE, MwR, MwE>,
  ): Layer.Layer<
    Roop | LanguageModel.LanguageModel | Journal | AgentRuntime | MiddlewareService,
    ModelE | JournalE | MwE,
    ModelR | JournalR | MwR
  > => {
    const modelLayer = Layer.isLayer(options.model)
      ? (options.model as Layer.Layer<LanguageModel.LanguageModel, ModelE, ModelR>)
      : (Layer.succeed(
          LanguageModel.LanguageModel,
          options.model as LanguageModel.Service,
        ) as unknown as Layer.Layer<LanguageModel.LanguageModel, ModelE, ModelR>)

    const journalLayer =
      options.journal ?? (JournalMemory as unknown as Layer.Layer<Journal, JournalE, JournalR>)

    let middlewareLayer: Layer.Layer<MiddlewareService, MwE, MwR>
    if (options.middleware === undefined) {
      middlewareLayer = middlewareLayerEmpty as unknown as Layer.Layer<MiddlewareService, MwE, MwR>
    } else if (Layer.isLayer(options.middleware)) {
      middlewareLayer = options.middleware as Layer.Layer<MiddlewareService, MwE, MwR>
    } else {
      const combined = allMiddleware(...(options.middleware as ReadonlyArray<Middleware<MwR, MwE>>))
      middlewareLayer = Layer.succeed(
        MiddlewareService,
        MiddlewareService.of(combined as unknown as Middleware),
      ) as unknown as Layer.Layer<MiddlewareService, MwE, MwR>
    }

    const infraLayer = Layer.mergeAll(modelLayer, journalLayer, AgentRuntimeLive, middlewareLayer)

    const roopServiceLayer = Layer.effect(
      Roop,
      Effect.gen(function* () {
        const runtime = yield* AgentRuntime
        const journal = yield* Journal
        const model = yield* LanguageModel.LanguageModel
        return Roop.of({ runtime, journal, model })
      }),
    ).pipe(Layer.provide(infraLayer))

    return Layer.mergeAll(infraLayer, roopServiceLayer) as Layer.Layer<
      Roop | LanguageModel.LanguageModel | Journal | AgentRuntime | MiddlewareService,
      ModelE | JournalE | MwE,
      ModelR | JournalR | MwR
    >
  }
}

export const layer = Roop.layer
