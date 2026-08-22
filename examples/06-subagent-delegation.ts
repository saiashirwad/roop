import { Agent, JournalMemory, Module, Runtime } from "@roop/agent"
import { Clock, Console, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { Tool } from "effect/unstable/ai"

import { DeepSeek } from "./deepseek.ts"

/**
 * 06 - Subagent Orchestration & Delegation
 *
 * Demonstrates how Roop coordinates parent and child agents.
 * In Roop, delegation is an ordinary tool that runs a child Agent with
 * an isolated child session, providing complete traceability and structured concurrency.
 */

// 1. Define Child Specialist Agent (Research Agent)
const researchSubagent = Agent.make(
  "researcher",
  Module.instructions(
    "You are a specialized technical researcher. Provide a 2-sentence executive summary with key technical facts.",
  ),
)

// 2. Define Delegation Tool
const delegateResearchTool = Tool.make("delegate_research", {
  description: "Delegate in-depth technical research on a topic to a specialist subagent",
  parameters: Schema.Struct({ topic: Schema.String }),
  success: Schema.String,
  failure: Schema.String,
  failureMode: "return",
})

// 3. Define Parent Coordinator Agent (Lead Architect)
const leadAgent = Agent.make(
  "lead-architect",
  Module.all(
    Module.instructions(
      "You are a Lead Solutions Architect. When asked about complex topics, delegate research to your researcher subagent and present the final synthesized recommendation.",
    ),
    Module.tool(delegateResearchTool, ({ topic }, context) =>
      Effect.gen(function* () {
        yield* context.preliminary(`Delegating topic '${topic}' to research subagent...`)
        yield* Console.log(`\n➡️  [Parent -> Subagent] Delegating research task: "${topic}"`)

        const now = yield* Clock.currentTimeMillis
        const childSessionId = `child-research-${now}`

        // Run child agent with structured concurrency (automatic cancellation propagation)
        const events = yield* Effect.acquireUseRelease(
          Runtime.runAgent(researchSubagent, {
            sessionId: childSessionId,
            prompt: `Research topic: ${topic}`,
          }).pipe(Stream.runCollect, Effect.forkChild),
          Fiber.join,
          Fiber.interrupt,
        ).pipe(Effect.mapError((cause) => String(cause)))

        const textParts: string[] = []
        for (const event of events) {
          if (event._tag === "TextDelta") {
            textParts.push(event.delta)
          }
        }
        const textOutput = textParts.join("")

        yield* Console.log(
          `⬅️  [Subagent -> Parent] Subagent finished with findings: "${textOutput.trim()}"\n`,
        )

        return textOutput
      }),
    ),
  ),
)

const program = Effect.gen(function* () {
  yield* Console.log("=== Roop Subagent Orchestration ===")

  const events = Runtime.runAgent(leadAgent, {
    sessionId: "lead-session-77",
    prompt:
      "I need an architectural comparison between Effect-TS fibers and traditional JavaScript Promises.",
  })

  yield* events.pipe(
    Stream.tap((event) => {
      switch (event._tag) {
        case "ToolCall":
          return Console.log(`[Lead Agent invoked]: ${event.name}`, event.params)
        case "TextDelta":
          process.stdout.write(event.delta)
          return Effect.void
        case "Finish":
          return Console.log(`\n\n[Orchestration complete: ${event.reason}]`)
        default:
          return Effect.void
      }
    }),
    Stream.runDrain,
    Effect.provide(
      Layer.mergeAll(JournalMemory.JournalMemory, Runtime.AgentRuntimeLive, DeepSeek.Live),
    ),
  )
})

if (process.argv[1]?.endsWith("06-subagent-delegation.ts")) {
  Effect.runPromise(program).catch(console.error)
}
