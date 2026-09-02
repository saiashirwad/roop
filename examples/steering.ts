import { Agent, Journal, Roop } from "@roop/agent"
import { Console, Effect, Ref, Schema, Stream } from "effect"
import { Tool } from "effect/unstable/ai"

import { DeepSeek } from "./deepseek.ts"

const lookupDefinition = Tool.make("lookup_docs", {
  description: "Look up a one-line summary of an Effect module by name",
  parameters: Schema.Struct({ module: Schema.String }),
  success: Schema.String,
})

/** A slow tool: while it runs, the user has time to change the request. */
const lookupDocs = Agent.tool(lookupDefinition, ({ module }) =>
  Effect.sleep("2 seconds").pipe(
    Effect.as(`${module}: an Effect module; see https://effect.website for its reference.`),
  ),
)

const writer = Agent.make({
  name: "writer",
  instructions:
    "You write short overviews of Effect modules. Before writing, look up every module you will mention with lookup_docs. Answer in at most four sentences.",
  tools: [lookupDocs],
})

const Live = Roop.layer({ model: DeepSeek.Live, journal: Journal.memory })

/**
 * `Agent.start` returns a handle instead of a stream: `events` is the live
 * stream, `result` settles when the run ends, and `send` delivers a message
 * to the running run. The interpreter commits the message as a `user/message`
 * at the next step boundary, after the tool results of the step in progress,
 * so the model sees it in its next request and the run keeps going.
 */
const program = Effect.gen(function* () {
  const handle = yield* Agent.start(writer, {
    sessionId: "steering",
    prompt: "Write a short overview of the Effect Stream module.",
  })

  // Steer once: on the first tool call, or after a short delay if the model
  // answers without one. A message sent after the run ended fails with
  // RunEnded, which is what "start a new run instead" looks like here.
  const steered = yield* Ref.make(false)
  const steer = Effect.gen(function* () {
    if (yield* Ref.getAndSet(steered, true)) return
    yield* Console.log("\n[you] Also mention the Effect Schema module.")
    yield* handle.send({ _tag: "user/message", content: "Also mention the Effect Schema module." })
  }).pipe(Effect.ignore)
  yield* Effect.sleep("5 seconds").pipe(Effect.andThen(steer), Effect.forkScoped)

  yield* Stream.runForEach(handle.events, (event) => {
    switch (event._tag) {
      case "tool/call":
        return Console.log(`\n[tool] ${event.name} ${JSON.stringify(event.params)}`).pipe(
          Effect.andThen(steer),
        )
      case "user/message":
        // The steering message shows up in the run's own journal events.
        return Console.log(`[journal] user/message: ${event.content}`)
      case "text/delta":
        return Effect.sync(() => process.stdout.write(event.delta))
      default:
        return Effect.void
    }
  })

  const result = yield* handle.result
  yield* Console.log(
    `\n\n[${result.finishReason}] ${result.toolCalls.length} tool calls, ${result.usage.totalTokens} tokens`,
  )
  yield* Console.log(`\nFinal text:\n${result.text}`)
}).pipe(Effect.scoped, Effect.provide(Live))

if (process.argv[1]?.endsWith("steering.ts")) {
  Effect.runPromise(program).catch(console.error)
}
