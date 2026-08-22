import { type Agent, Module, Runtime } from "@roop/agent"
import { Effect, Fiber, Schema, Stream } from "effect"
import { Tool } from "effect/unstable/ai"

export const Delegate = Tool.make("delegate", {
  description: "Run a task with a child agent",
  parameters: Schema.Struct({ task: Schema.String }),
  success: Schema.String,
  failure: Schema.String,
  failureMode: "return",
})

/** Delegation is an ordinary tool with an explicit child and stable child session. */
export const subagent = (child: Agent.AgentDefinition<never, never>, childSessionId: string) =>
  Module.tool(Delegate, ({ task }, context) =>
    Effect.gen(function* () {
      yield* context.preliminary("delegating")
      const runtime = yield* Runtime.AgentRuntime
      const events = yield* Effect.acquireUseRelease(
        runtime
          .run(child, { sessionId: childSessionId, prompt: task })
          .pipe(Stream.runCollect, Effect.forkChild),
        Fiber.join,
        Fiber.interrupt,
      ).pipe(Effect.mapError((cause) => String(cause)))
      return JSON.stringify([...events])
    }),
  )
