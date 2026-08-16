import { Effect, Schema, Stream } from "effect"
import { Tool } from "effect/unstable/ai"

import type { Agent } from "./Agent.ts"
import { AgentEmit } from "./AgentEmit.ts"
import type { AgentEvent } from "./AgentEvent.ts"
import type { RunError } from "./RunError.ts"
import type { RunPolicy } from "./RunPolicy.ts"

export class DelegationFailed extends Schema.TaggedErrorClass<DelegationFailed>()(
  "DelegationFailed",
  { message: Schema.String },
) {}

export type DelegationOptions = {
  readonly name: string
  readonly description: string
  readonly modelId?: string | undefined
  readonly policy?: RunPolicy | undefined
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
        return new DelegationFailed({ message: "delegated agent hit its step/turn limit" })
      }
    }
  }

  const handler = (agent: Agent["Service"]) => (params: { readonly task: string }) =>
    Effect.gen(function* () {
      const emit = yield* Effect.serviceOption(AgentEmit)
      let summary = ""
      let failure: DelegationFailed | undefined

      yield* Stream.runForEach(
        agent.prompt({
          prompt: params.task,
          modelId: options.modelId,
          policy: options.policy,
        }),
        (event) =>
          Effect.gen(function* () {
            if (emit._tag === "Some") {
              yield* emit.value.emit({
                _tag: "Subagent",
                name: options.name,
                ...(emit.value.toolCallId === undefined
                  ? undefined
                  : { toolCallId: emit.value.toolCallId }),
                event,
              })
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
          SessionFormatError: (error) =>
            new DelegationFailed({ message: `corrupt session log: ${error.message}` }),
          RunError: (error: RunError) =>
            new DelegationFailed({ message: `delegated agent ${error.operation} failed` }),
        }),
      )

      if (failure !== undefined) return yield* failure
      return { summary: summary.trim() || "(no output)" }
    })

  return { tool, handler }
}
