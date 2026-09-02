import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Agent, Journal, Roop } from "@roop/agent"
import { JournalFs } from "@roop/journal-fs"
import { Console, DateTime, Effect, Layer, Option } from "effect"

import { DeepSeek } from "./deepseek.ts"

const assistant = Agent.make({
  name: "memory-assistant",
  instructions:
    "You are a friendly personal assistant. Remember user details accurately across turns.",
})

// One NDJSON log per session under ./.roop/sessions. Run this file twice: the
// second run loads the first run's history from disk and asks the model to recall it.
const Live = Roop.layer({
  model: DeepSeek.Live,
  journal: JournalFs.layer({ directory: "./.roop/sessions" }).pipe(
    Layer.provide([NodeFileSystem.layer, NodePath.layer]),
  ),
})

const program = Effect.gen(function* () {
  const journal = yield* Journal.Journal
  const sessionId = "persistent-user-session-88"
  const conversation = Agent.session(assistant, sessionId)

  const stored = yield* journal.load(sessionId)
  yield* Console.log(`Loaded ${stored.revision} events for ${sessionId}`)

  const reply =
    stored.revision === 0
      ? yield* conversation.run(
          "Hello! My name is Sarah and my favorite programming language is TypeScript with Effect.",
          { meta: { title: "Sarah's introduction", cwd: process.cwd() } },
        )
      : yield* conversation.run(
          "Can you recall what my name is and what programming language I like?",
        )
  yield* Console.log(reply.text)

  const sessions = yield* journal.list
  for (const session of sessions) {
    yield* Console.log(
      `${session.sessionId}: ${session.revision} events, title=${Option.getOrElse(session.title, () => "-")}, updated=${DateTime.formatIso(DateTime.makeUnsafe(session.updatedAt))}`,
    )
  }
}).pipe(Effect.provide(Live))

if (process.argv[1]?.endsWith("persistent-conversations.ts")) {
  Effect.runPromise(program).catch(console.error)
}
