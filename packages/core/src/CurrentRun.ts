import { Context } from "effect"
import type { Deferred } from "effect"
import type { LanguageModel } from "effect/unstable/ai"

/** Fiber-local parent run context for tool handlers (e.g. spawnAgent). */
export type CurrentRunService = {
  readonly sessionId: string
  readonly runId: string
  readonly interrupt: Deferred.Deferred<void>
  readonly model: LanguageModel.Service
  readonly depth: number
}

export class CurrentRun extends Context.Service<CurrentRun, CurrentRunService>()(
  "roop/CurrentRun",
) {}
