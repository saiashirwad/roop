import { Context, Effect, Layer } from "effect"
import { LanguageModel } from "effect/unstable/ai"

import { Journal, memory as journalMemory, type JournalService } from "./Journal.ts"
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
  /** Erased middleware values, or a Layer for middleware built from services. */
  readonly middleware?:
    | ReadonlyArray<Middleware>
    | Layer.Layer<MiddlewareService, MwE, MwR>
    | undefined
}

export interface RoopService {
  readonly runtime: AgentRuntimeService
  readonly journal: JournalService
  readonly model: LanguageModel.Service
}

/** The composed kernel: model, journal, runtime, and middleware in one layer. */
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
  ) => {
    const model =
      "streamText" in options.model
        ? Layer.succeed(LanguageModel.LanguageModel, options.model)
        : options.model
    const middleware =
      options.middleware === undefined
        ? middlewareLayerEmpty
        : "length" in options.middleware
          ? Layer.succeed(MiddlewareService, allMiddleware(...options.middleware))
          : options.middleware
    const infrastructure = Layer.mergeAll(
      model,
      options.journal ?? journalMemory,
      AgentRuntimeLive,
      middleware,
    )
    return Layer.effect(
      Roop,
      Effect.all({ runtime: AgentRuntime, journal: Journal, model: LanguageModel.LanguageModel }),
    ).pipe(Layer.provideMerge(infrastructure))
  }
}

export const layer = Roop.layer
