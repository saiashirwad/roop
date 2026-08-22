import { Agent, JournalMemory, Module, Runtime } from "@roop/agent"
import { Console, Effect, Layer, Stream } from "effect"

import { DeepSeek } from "./deepseek.ts"

/**
 * 04 - DeepSeek Reasoner (R1) with Live Thinking Stream
 *
 * Demonstrates real-time streaming of both reasoning thoughts (`ReasoningDelta`)
 * and answer tokens (`TextDelta`) using DeepSeek-R1 (`deepseek-reasoner`).
 */
const reasoningAgent = Agent.make(
  "math-reasoner",
  Module.instructions(
    "You are a rigorous mathematical and logical reasoning assistant. Always explain your reasoning clearly.",
  ),
)

const program = Effect.gen(function* () {
  yield* Console.log("=== Roop DeepSeek Reasoner (R1 Thinking Stream) ===")

  let isThinking = false

  const events = Runtime.runAgent(reasoningAgent, {
    sessionId: "reasoning-session-101",
    prompt: "How many letters 'r' are in the word 'strawberry'? Think step by step.",
  })

  yield* events.pipe(
    Stream.tap((event) => {
      switch (event._tag) {
        case "ReasoningDelta":
          if (!isThinking) {
            isThinking = true
            process.stdout.write("\n🧠 [Thinking Process]:\n\x1b[90m")
          }
          process.stdout.write(event.delta)
          return Effect.void

        case "TextDelta":
          if (isThinking) {
            isThinking = false
            process.stdout.write("\x1b[0m\n\n💡 [Final Answer]:\n")
          }
          process.stdout.write(event.delta)
          return Effect.void

        case "Finish":
          return Console.log(`\n\n[Finished with status: ${event.reason}]`)

        default:
          return Effect.void
      }
    }),
    Stream.runDrain,
    Effect.provide(Layer.mergeAll(JournalMemory.JournalMemory, DeepSeek.reasonerLive)),
  )
})

if (process.argv[1]?.endsWith("04-reasoning-agent.ts")) {
  Effect.runPromise(program).catch(console.error)
}
