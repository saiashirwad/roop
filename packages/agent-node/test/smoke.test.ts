import { assert, it } from "@effect/vitest"
import { Agent, AgentLiveToolkit } from "@roop/agent/Agent.ts"
import { SessionStoreMemory } from "@roop/agent/SessionStore.ts"
import { Effect, Layer, Stream } from "effect"
import { Toolkit } from "effect/unstable/ai"

import { DeepSeekLive } from "../src/DeepSeek.ts"

const apiKey = process.env.DEEPSEEK_API_KEY

it.layer(
  AgentLiveToolkit(Toolkit.empty).pipe(
    Layer.provide(DeepSeekLive(apiKey ?? "")),
    Layer.provide(SessionStoreMemory),
  ),
)("DeepSeek live", (it) => {
  it.effect.skipIf(apiKey === undefined)("streams a text reply", () =>
    Effect.gen(function* () {
      const agent = yield* Agent
      const events = yield* Stream.runCollect(
        agent.prompt({
          prompt: "Reply with exactly the word banana and nothing else.",
          sessionId: "live",
        }),
      )

      const deltas = [...events]
        .filter((event) => event._tag === "TextDelta")
        .map((event) => event.delta)
        .join("")
      assert.ok(deltas.toLowerCase().includes("banana"), `expected banana, got: ${deltas}`)

      const finish = [...events].find((event) => event._tag === "Finish")
      assert.ok(finish !== undefined && finish.reason === "completed")
    }),
  )
})
