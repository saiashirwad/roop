import { assert, it } from "@effect/vitest"
import { Deferred, Effect, Layer, Ref, Schema, Stream } from "effect"
import { LanguageModel, type Prompt, type Response } from "effect/unstable/ai"

import { Agent } from "../src/Agent.ts"
import { memory as JournalMemory } from "../src/Journal.ts"
import { AgentRuntimeLive } from "../src/Runtime.ts"

const worker = Agent.make({ name: "worker", instructions: "You are a worker." })

const lead = Agent.make({
  name: "lead",
  instructions: "You are the lead.",
  tools: [
    Agent.spawn(worker, {
      name: "start_work",
      parameters: Schema.Struct({ topic: Schema.String }),
      prompt: ({ topic }) => `Work on ${topic}`,
    }),
  ],
})

const systemText = (prompt: Prompt.Prompt): string =>
  prompt.content
    .flatMap((message) => (message.role === "system" ? [message.content] : []))
    .join("\n")

const lastUserText = (prompt: Prompt.Prompt): string => {
  const users = prompt.content.filter((message) => message.role === "user")
  const last = users[users.length - 1]
  if (last === undefined || last.role !== "user") return ""
  return last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
}

/**
 * A model that answers by role: workers echo their prompt, the lead starts two
 * workers, then collects every task, then answers with the collected text.
 */
const makeModel = (workerGate: Deferred.Deferred<void>) =>
  Effect.gen(function* () {
    const leadCalls = yield* Ref.make(0)
    return yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: (options) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const parts = (...parts: ReadonlyArray<Response.StreamPartEncoded>) =>
              Stream.fromIterable(parts)
            if (systemText(options.prompt).includes("worker")) {
              yield* Deferred.await(workerGate)
              return parts({
                type: "text-delta",
                id: "t",
                delta: `done: ${lastUserText(options.prompt)}`,
              })
            }
            const call = yield* Ref.updateAndGet(leadCalls, (n) => n + 1)
            switch (call) {
              case 1:
                return parts(
                  { type: "tool-call", id: "c1", name: "start_work", params: { topic: "alpha" } },
                  { type: "tool-call", id: "c2", name: "start_work", params: { topic: "beta" } },
                )
              case 2:
                return parts({ type: "tool-call", id: "c3", name: "await_start_work", params: {} })
              default: {
                const tools = options.prompt.content.filter((message) => message.role === "tool")
                return parts({
                  type: "text-delta",
                  id: "t",
                  delta: JSON.stringify(tools.map((message) => message.content)),
                })
              }
            }
          }),
        ),
    })
  })

it.effect("starts children in the background and collects them later", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>()
    yield* Deferred.succeed(gate, undefined)
    const model = yield* makeModel(gate)
    const result = yield* Agent.run(lead, { sessionId: "spawn", prompt: "go" }).pipe(
      Effect.provide(Layer.mergeAll(JournalMemory, AgentRuntimeLive)),
      Effect.provideService(LanguageModel.LanguageModel, model),
    )
    assert.strictEqual(result.finishReason, "completed")
    // The start calls returned task ids before any worker produced output.
    const starts = result.toolResults.filter((r) => r.name === "start_work")
    assert.strictEqual(starts.length, 2)
    assert.match(JSON.stringify(starts[0]?.result), /worker:1/)
    assert.match(JSON.stringify(starts[1]?.result), /worker:2/)
    // The single await collected both workers, in start order.
    const collected = result.toolResults.find((r) => r.name === "await_start_work")
    assert.ok(collected !== undefined && !collected.isFailure)
    const text = String(collected?.result)
    assert.ok(text.indexOf("done: Work on alpha") < text.indexOf("done: Work on beta"))
    assert.ok(result.text.includes("done: Work on alpha"))
  }),
)

it.effect("interrupts children that were never collected when the run ends", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>()
    const model = yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: (options) =>
        systemText(options.prompt).includes("worker")
          ? Stream.fromEffect(Deferred.await(gate)).pipe(
              Stream.map(() => ({ type: "text-delta" as const, id: "t", delta: "late" })),
            )
          : Stream.make({
              type: "tool-call" as const,
              id: "c1",
              name: "start_work",
              params: { topic: "orphan" },
            }),
    })
    const result = yield* Agent.run(lead, {
      sessionId: "orphan",
      prompt: "go",
      policy: { maxStepsPerTurn: 1 },
    }).pipe(
      Effect.provide(Layer.mergeAll(JournalMemory, AgentRuntimeLive)),
      Effect.provideService(LanguageModel.LanguageModel, model),
    )
    assert.strictEqual(result.finishReason, "stopped")
    assert.strictEqual(result.toolResults.filter((r) => r.name === "start_work").length, 1)
    // The parent run finished; the orphaned child was interrupted with it and
    // nothing here waits on the gate.
  }),
)
