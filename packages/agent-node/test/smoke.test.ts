import { assert, it } from "@effect/vitest"
import { Agent } from "@roop/agent/Agent.ts"
import { AgentPlugins } from "@roop/agent/Plugin.ts"
import { SessionStoreMemory } from "@roop/agent/SessionStore.ts"
import { Effect, Layer, Stream } from "effect"

import { DeepSeek } from "../src/DeepSeek.ts"

const apiKey = process.env.DEEPSEEK_API_KEY

it.layer(AgentPlugins([DeepSeek(apiKey ?? "")]).pipe(Layer.provide(SessionStoreMemory)))(
  "DeepSeek live",
  (it) => {
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
  },
)
