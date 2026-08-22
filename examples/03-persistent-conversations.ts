import { Agent, Journal, JournalMemory, Module, Runtime } from "@roop/agent"
import { Console, Effect, Layer, Stream } from "effect"

import { DeepSeek } from "./deepseek.ts"

/**
 * 03 - Persistent Conversations & Durable State
 *
 * Demonstrates how Roop maintains multi-turn conversation state using durable Journals.
 * Contrast with Flue: Flue uses React-style `usePersistentState`. Roop uses semantic
 * event journals (`Journal`) that automatically preserve conversational context across turns.
 */
const assistant = Agent.make(
  "memory-assistant",
  Module.instructions(
    "You are a friendly personal assistant. Remember user details accurately across turns.",
  ),
)

const runTurn = (sessionId: string, prompt: string) =>
  Effect.gen(function* () {
    yield* Console.log(`\n--- User Prompt: "${prompt}" ---`)
    yield* Console.log("Assistant Reply: ")

    yield* Runtime.runAgent(assistant, {
      sessionId,
      prompt,
    }).pipe(
      Stream.tap((event) => {
        if (event._tag === "TextDelta") {
          process.stdout.write(event.delta)
        }
        return Effect.void
      }),
      Stream.runDrain,
    )
    yield* Console.log("")
  })

const program = Effect.gen(function* () {
  yield* Console.log("=== Roop Persistent Multi-Turn Conversation ===")
  const sessionId = "persistent-user-session-88"

  // Turn 1: Introduce user details
  yield* runTurn(
    sessionId,
    "Hello! My name is Sarah and my favorite programming language is TypeScript with Effect.",
  )

  // Turn 2: Follow-up question relying on previous turn's context
  yield* runTurn(sessionId, "Can you recall what my name is and what programming language I like?")

  // Inspect the durable Journal events
  const journal = yield* Journal
  const session = yield* journal.load(sessionId)
  yield* Console.log(`\n[Journal Status] Total durable events stored: ${session.events.length}`)
  yield* Console.log(`[Journal Revision]: ${session.revision}`)
}).pipe(Effect.provide(Layer.mergeAll(JournalMemory.JournalMemory, DeepSeek.Live)))

if (process.argv[1]?.endsWith("03-persistent-conversations.ts")) {
  Effect.runPromise(program).catch(console.error)
}
