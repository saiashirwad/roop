import { Agent, Journal, Roop } from "@roop/agent"
import { scripted } from "@roop/agent/testing"
import { Effect } from "effect"

const program = Effect.gen(function* () {
  const model = yield* scripted([[{ type: "text-delta", id: "text", delta: "hello consumer" }]])

  const assistant = Agent.make({
    name: "consumer-agent",
    instructions: "Answer concisely.",
  })

  const Live = Roop.layer({
    model,
    journal: Journal.memory,
  })

  const result = yield* Agent.run(assistant, {
    sessionId: "consumer-session-1",
    prompt: "hi",
  }).pipe(Effect.provide(Live))

  if (result.text !== "hello consumer") {
    throw new Error(`Unexpected result text: ${result.text}`)
  }
  if (result.finishReason !== "completed") {
    throw new Error(`Unexpected finish reason: ${result.finishReason}`)
  }
})

await Effect.runPromise(program)
