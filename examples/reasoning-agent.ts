import { Agent, Journal, Roop } from "@roop/agent"
import { Console, Effect, Stream } from "effect"

import { DeepSeek } from "./deepseek.ts"

const reasoningAgent = Agent.make({
  name: "math-reasoner",
  instructions:
    "You are a rigorous mathematical and logical reasoning assistant. Always explain your reasoning clearly.",
})

const Live = Roop.layer({
  model: DeepSeek.reasonerLive,
  journal: Journal.memory,
})

const program = Effect.gen(function* () {
  const events = Agent.events(reasoningAgent, {
    sessionId: "reasoning-session-101",
    prompt: "How many letters 'r' are in the word 'strawberry'? Think step by step.",
  })

  // Reasoning tokens stream as `reasoning/delta` and the answer as `text/delta`.
  yield* events.pipe(
    Stream.tap((event) => {
      switch (event._tag) {
        case "reasoning/delta":
          process.stdout.write(`\x1b[2m${event.delta}\x1b[0m`)
          return Effect.void
        case "text/delta":
          process.stdout.write(event.delta)
          return Effect.void
        case "model/attempt":
          return event.state === "completed" && event.usage !== undefined
            ? Console.log(
                `\n[${event.model ?? "model"}] ${event.usage.reasoningTokens ?? 0} reasoning + ${event.usage.outputTokens} output tokens`,
              )
            : Effect.void
        default:
          return Effect.void
      }
    }),
    Stream.runDrain,
  )
}).pipe(Effect.provide(Live))

if (process.argv[1]?.endsWith("reasoning-agent.ts")) {
  Effect.runPromise(program).catch(console.error)
}
