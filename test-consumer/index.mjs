import { Agent, JournalMemory, Module, Runtime } from "@roop/agent"
import { scripted } from "@roop/agent/testing"
import { Effect, Layer, Stream } from "effect"
import { LanguageModel } from "effect/unstable/ai"

const program = Effect.gen(function* () {
  const model = yield* scripted([[{ type: "text-delta", id: "text", delta: "ok" }]])
  const events = yield* Runtime.runAgent(Agent.make("packed", Module.empty), {
    sessionId: "packed",
    prompt: "hello",
  }).pipe(
    Stream.runCollect,
    Effect.provide(
      Layer.mergeAll(
        JournalMemory.JournalMemory,
        Layer.succeed(LanguageModel.LanguageModel, model),
      ),
    ),
  )
  if (!events.some((event) => event._tag === "Finish")) throw new Error("missing Finish")
})

await Effect.runPromise(program)
