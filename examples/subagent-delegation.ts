import { Agent, Journal, Roop } from "@roop/agent"
import { Console, Effect, Schema } from "effect"

import { DeepSeek } from "./deepseek.ts"

const researcher = Agent.make({
  name: "researcher",
  instructions:
    "You are a specialized technical researcher. Provide a 2-sentence executive summary with key technical facts.",
})

const leadArchitect = Agent.make({
  name: "lead-architect",
  instructions:
    "You are a Lead Solutions Architect. When asked about complex topics, delegate research to your researcher subagent and present the final synthesized recommendation.",
  tools: [
    Agent.delegate(researcher, {
      name: "delegate_research",
      description: "Delegate in-depth technical research on a topic to a specialist researcher",
      parameters: Schema.Struct({ topic: Schema.String }),
      prompt: ({ topic }) => `Research topic: ${topic}`,
    }),
  ],
})

const Live = Roop.layer({ model: DeepSeek.Live, journal: Journal.memory })

const program = Effect.gen(function* () {
  const session = Agent.session(leadArchitect, "lead-session-77")

  const reply = yield* session.run(
    "I need an architectural comparison between Effect fibers and traditional JavaScript Promises.",
  )

  yield* Console.log(reply.text)
}).pipe(Effect.provide(Live))

if (process.argv[1]?.endsWith("subagent-delegation.ts")) {
  Effect.runPromise(program).catch(console.error)
}
