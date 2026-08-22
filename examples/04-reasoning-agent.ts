import { Agent, Journal, Roop } from "@roop/agent"
import { Effect, Stream } from "effect"

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

  yield* events.pipe(
    Stream.tap((event) => {
      if (event._tag === "TextDelta") {
        process.stdout.write(event.delta)
      }
      return Effect.void
    }),
    Stream.runDrain,
  )
}).pipe(Effect.provide(Live))

if (process.argv[1]?.endsWith("04-reasoning-agent.ts")) {
  Effect.runPromise(program).catch(console.error)
}
