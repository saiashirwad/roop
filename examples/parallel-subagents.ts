import { Agent, Journal, Roop } from "@roop/agent"
import { Console, Effect, Schema, Stream } from "effect"

import { DeepSeek } from "./deepseek.ts"

const researcher = Agent.make({
  name: "researcher",
  instructions:
    "You are a technical researcher. Answer the question in at most three sentences with concrete facts.",
})

/**
 * `Agent.spawn` gives the lead two tools: `research` starts a researcher in
 * the background and returns a task id at once, `await_research` collects one
 * task or every task started so far. The model can fan out several researchers
 * in a single step and gather them when it needs the answers.
 */
const lead = Agent.make({
  name: "lead",
  instructions:
    "You coordinate research. When asked to compare several things, start one researcher per item with the research tool in the same step, then call await_research once with no arguments to collect every result, then write the comparison.",
  tools: [
    Agent.spawn(researcher, {
      name: "research",
      parameters: Schema.Struct({ question: Schema.String }),
      prompt: ({ question }) => question,
    }),
  ],
})

const Live = Roop.layer({ model: DeepSeek.Live, journal: Journal.memory })

const program = Agent.events(lead, {
  sessionId: "parallel-research",
  prompt:
    "Compare the concurrency models of Erlang, Go, and Effect-TS. Research each one separately first.",
}).pipe(
  Stream.runForEach((event) => {
    switch (event._tag) {
      case "ToolCall":
        return Console.log(`\n[tool] ${event.name} ${JSON.stringify(event.params)}`)
      case "ToolResult":
        return Console.log(`[result] ${event.name}: ${String(event.result).slice(0, 80)}...`)
      case "Subagent":
        // The researchers stream while the lead waits; their events arrive tagged.
        return event.event._tag === "TextDelta"
          ? Effect.sync(() => process.stdout.write("."))
          : Effect.void
      case "TextDelta":
        return Effect.sync(() => process.stdout.write(event.delta))
      default:
        return Effect.void
    }
  }),
  Effect.provide(Live),
)

if (process.argv[1]?.endsWith("parallel-subagents.ts")) {
  Effect.runPromise(program).catch(console.error)
}
