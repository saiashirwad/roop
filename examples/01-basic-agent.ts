import { Agent, Journal, Roop } from "@roop/agent"
import { Console, Effect } from "effect"

import { DeepSeek } from "./deepseek.ts"

const assistant = Agent.make({
  name: "assistant",
  instructions:
    "You are a helpful and concise assistant. Answer questions clearly in 1-2 sentences.",
})

const Live = Roop.layer({
  model: DeepSeek.Live,
  journal: Journal.memory,
})

const program = Effect.gen(function* () {
  const reply = yield* Agent.run(assistant, {
    sessionId: "user-session-001",
    prompt: "Why is the sky blue?",
  })

  yield* Console.log(reply.text)
}).pipe(Effect.provide(Live))

if (process.argv[1]?.endsWith("01-basic-agent.ts")) {
  Effect.runPromise(program).catch(console.error)
}
