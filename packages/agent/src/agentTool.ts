import { Effect, Schema, Stream } from "effect"
import { Tool } from "effect/unstable/ai"

import type { AgentService } from "./Agent.ts"
import { AgentEmit } from "./AgentEmit.ts"
import type { AgentEvent } from "./AgentEvent.ts"

export class DelegationFailed extends Schema.TaggedErrorClass<DelegationFailed>()(
  "DelegationFailed",
  { message: Schema.String },
) {}

export type DelegationOptions = {
  readonly name: string
  readonly description: string
  readonly modelId?: string | undefined
  readonly maxTurns?: number | undefined
}

export const delegation = (options: DelegationOptions) => {
  const tool = Tool.make(options.name, {
    description: options.description,
    parameters: Schema.Struct({ task: Schema.String }),
    success: Schema.Struct({ summary: Schema.String }),
    failure: DelegationFailed,
    failureMode: "return",
  })

  const failureFor = (event: Extract<AgentEvent, { _tag: "Finish" }>) => {
    switch (event.reason) {
      case "completed": {
        return undefined
      }
      case "failed": {
        return new DelegationFailed({ message: event.message ?? "delegated agent failed" })
      }
      case "interrupted": {
        return new DelegationFailed({ message: "delegated agent was interrupted" })
      }
      case "stopped": {
        return new DelegationFailed({ message: "delegated agent hit its turn cap" })
      }
    }
  }

  const handler = (agent: AgentService) => (params: { readonly task: string }) =>
    Effect.gen(function* () {
      const emit = yield* Effect.serviceOption(AgentEmit)
      let summary = ""
      let failure: DelegationFailed | undefined

      yield* Stream.runForEach(
        agent.prompt({
          prompt: params.task,
          ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
          ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
        }),
        (event) =>
          Effect.gen(function* () {
            if (emit._tag === "Some") {
              yield* emit.value.emit({ _tag: "Subagent", name: options.name, event })
            }
            if (event._tag === "TextDelta") summary += event.delta
            if (event._tag === "Finish") failure = failure ?? failureFor(event)
          }),
      ).pipe(
        Effect.catchTags({
          ModelNotFound: (error) =>
            new DelegationFailed({ message: `model not found: ${error.modelId}` }),
          SessionBusy: (error) =>
            new DelegationFailed({ message: `session busy: ${error.sessionId}` }),
        }),
      )

      if (failure !== undefined) return yield* failure
      return { summary: summary.trim() || "(no output)" }
    })

  return { tool, handler }
}
