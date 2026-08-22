import { Agent, Journal, Roop } from "@roop/agent"
import { Console, Effect } from "effect"

import { DeepSeek } from "./deepseek.ts"

const assistant = Agent.make({
  name: "memory-assistant",
  instructions:
    "You are a friendly personal assistant. Remember user details accurately across turns.",
})

const Live = Roop.layer({
  model: DeepSeek.Live,
  journal: Journal.memory,
})

const program = Effect.gen(function* () {
  const sessionId = "persistent-user-session-88"
  const conversation = Agent.session(assistant, sessionId)

  const reply1 = yield* conversation.run(
    "Hello! My name is Sarah and my favorite programming language is TypeScript with Effect.",
  )
  yield* Console.log(reply1.text)

  const reply2 = yield* conversation.run(
    "Can you recall what my name is and what programming language I like?",
  )
  yield* Console.log(reply2.text)
}).pipe(Effect.provide(Live))

if (process.argv[1]?.endsWith("03-persistent-conversations.ts")) {
  Effect.runPromise(program).catch(console.error)
}
