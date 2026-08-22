import { Context, Effect, Layer, Stream } from "effect"
import { Chat, LanguageModel, Prompt, type AiError } from "effect/unstable/ai"

import type { AgentDefinition } from "./Agent.ts"
import type { AgentEvent, SessionEvent } from "./AgentEvents.ts"
import { hooksNoop, type AgentHooksInterface } from "./AgentHooks.ts"
import type { ModelAttemptPolicy } from "./internal/effectAiAdapter.ts"
import { run } from "./internal/run.ts"
import type { RunError } from "./RunError.ts"
import type { RunPolicy } from "./RunPolicy.ts"
import { InterruptSignal, type InterruptSignal as InterruptSignalValue } from "./RunSignal.ts"
import { ToolRegistry, type InvalidToolName, type ToolConflict } from "./ToolRegistry.ts"

/** Input for one direct, scoped kernel run. */
export interface AgentRuntimeRequest {
  readonly sessionId: string
  readonly runId?: string | undefined
  readonly prompt: string
  readonly history?: Prompt.Prompt | undefined
  readonly policy?: RunPolicy | undefined
  readonly interrupt?: InterruptSignalValue | undefined
  readonly append?: ((event: SessionEvent) => Effect.Effect<void, RunError>) | undefined
  readonly hooks?: AgentHooksInterface | undefined
  /** Internal logical-attempt seam. Public fallback policy belongs to U6. */
  readonly attemptPolicy?: ModelAttemptPolicy | undefined
}

export interface AgentRuntimeService {
  readonly run: <R, E>(
    agent: AgentDefinition<R, E>,
    request: AgentRuntimeRequest,
  ) => Stream.Stream<
    AgentEvent,
    E | AiError.AiError | RunError | InvalidToolName | ToolConflict,
    R | LanguageModel.LanguageModel
  >
}

const appendNothing = (_event: SessionEvent): Effect.Effect<void> => Effect.void

const runtimeRun = <R, E>(
  agent: AgentDefinition<R, E>,
  request: AgentRuntimeRequest,
): Stream.Stream<
  AgentEvent,
  E | AiError.AiError | RunError | InvalidToolName | ToolConflict,
  R | LanguageModel.LanguageModel
> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const model = yield* LanguageModel.LanguageModel
      const history = request.history ?? Prompt.empty
      const chat = yield* Chat.fromPrompt(Prompt.concat(history, Prompt.make(request.prompt)))
      const append = request.append ?? appendNothing
      yield* append({ _tag: "user/message", content: request.prompt })
      const emptyToolkit = yield* ToolRegistry.empty.finalize
      // SAFETY: runtimeRun has already supplied the model and empty toolkit;
      // the explicit agent remains the only source of R and E at this boundary.
      return run({
        sessionId: request.sessionId,
        runId: request.runId,
        agent,
        chat,
        model,
        toolkit: Effect.succeed(emptyToolkit.toolkit),
        policy: request.policy,
        interrupt: request.interrupt ?? InterruptSignal.noop(),
        append,
        hooks: request.hooks ?? hooksNoop,
        attemptPolicy: request.attemptPolicy,
      }) as Stream.Stream<
        AgentEvent,
        E | AiError.AiError | RunError | InvalidToolName | ToolConflict,
        R | LanguageModel.LanguageModel
      >
    }),
  )

/** Effect capability for interpreting explicit Agent values. */
export class AgentRuntime extends Context.Service<AgentRuntime, AgentRuntimeService>()(
  "roop/AgentRuntime",
) {
  static readonly run = runtimeRun
}

/** A default capability layer for consumers that prefer service lookup. */
export const AgentRuntimeLive: Layer.Layer<AgentRuntime> = Layer.succeed(
  AgentRuntime,
  AgentRuntime.of({ run: runtimeRun }),
)

export const runAgent = runtimeRun
