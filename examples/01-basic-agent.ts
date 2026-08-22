import { Agent, JournalMemory, Module, Runtime } from "@roop/agent"
import { Console, Effect, Layer, Stream } from "effect"

import { DeepSeek } from "./deepseek.ts"

/**
 * 01 - Basic Assistant Agent
 *
 * Demonstrates a minimal, pure Effect-native agent.
 * This is the Roop equivalent of Flue's `MyAssistant`.
 */
const assistant = Agent.make(
  "assistant",
  Module.instructions(
    "You are a helpful and concise assistant. Answer questions clearly in 1-2 sentences.",
  ),
)

const program = Effect.gen(function* () {
  yield* Console.log("=== Roop Basic Agent ===")

  const events = Runtime.runAgent(assistant, {
    sessionId: "user-session-001",
    prompt: "Why is the sky blue?",
  })

  yield* events.pipe(
    Stream.tap((event) => {
      switch (event._tag) {
        case "TextDelta":
          process.stdout.write(event.delta)
          return Effect.void
        case "Finish":
          return Console.log(`\n\n[Finished with status: ${event.reason}]`)
        default:
          return Effect.void
      }
    }),
    Stream.runDrain,
    Effect.provide(Layer.mergeAll(JournalMemory.JournalMemory, DeepSeek.Live)),
  )
})

if (process.argv[1]?.endsWith("01-basic-agent.ts")) {
  Effect.runPromise(program).catch(console.error)
}
