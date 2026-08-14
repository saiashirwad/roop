import { Effect, Schema, Stream } from "effect"
import { Tool } from "effect/unstable/ai"

import type { AgentService } from "./Agent.ts"

export class DelegationFailed extends Schema.TaggedErrorClass<DelegationFailed>()(
  "DelegationFailed",
  { message: Schema.String },
) {}

export const asTool = (
  agent: AgentService,
  options: {
    readonly name: string
    readonly description: string
    readonly modelId?: string | undefined
    readonly maxTurns?: number | undefined
  },
) => {
  const tool = Tool.make(options.name, {
    description: options.description,
    parameters: Schema.Struct({ task: Schema.String }),
    success: Schema.Struct({ summary: Schema.String }),
    failure: DelegationFailed,
    failureMode: "return",
  })

  const handler = (params: { readonly task: string }) =>
    Effect.gen(function* () {
      const events = yield* Stream.runCollect(
        agent.prompt({
          prompt: params.task,
          ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
          ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
        }),
      ).pipe(
        Effect.catchTags({
          ModelNotFound: (error) =>
            new DelegationFailed({ message: `model not found: ${error.modelId}` }),
          SessionBusy: (error) =>
            new DelegationFailed({ message: `session busy: ${error.sessionId}` }),
        }),
      )

      let summary = ""
      for (const event of events) {
        if (event._tag === "Finish") {
          if (event.reason === "failed") {
            return yield* new DelegationFailed({
              message: event.message ?? "delegated agent failed",
            })
          }
          if (event.reason === "interrupted") {
            return yield* new DelegationFailed({ message: "delegated agent was interrupted" })
          }
          if (event.reason === "stopped") {
            return yield* new DelegationFailed({ message: "delegated agent hit its turn cap" })
          }
        }
        if (event._tag === "TextDelta") {
          summary += event.delta
        }
      }
      return { summary: summary.trim() || "(no output)" }
    })

  return { tool, handler }
}
