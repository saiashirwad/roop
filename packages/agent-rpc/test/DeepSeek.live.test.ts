import { assert, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { Toolkit } from "effect/unstable/ai"
import * as RpcTest from "effect/unstable/rpc/RpcTest"

import { AgentLiveToolkit } from "@roop/agent/Agent.ts"
import { DeepSeekLive } from "@roop/agent/DeepSeek.ts"
import { SessionStoreMemory } from "@roop/agent/SessionStore.ts"

import { AgentRpc } from "../src/AgentRpc.ts"
import { AgentRpcServer } from "../src/AgentRpcServer.ts"

const LiveLayer = (apiKey: string) =>
  AgentLiveToolkit(Toolkit.empty).pipe(
    Layer.provide(DeepSeekLive(apiKey)),
    Layer.provide(SessionStoreMemory),
  )

const apiKey = process.env.DEEPSEEK_API_KEY

it.layer(AgentRpcServer.pipe(Layer.provide(LiveLayer(apiKey ?? ""))))("DeepSeek live", (it) => {
  it.effect.skipIf(apiKey === undefined)("streams a text reply", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(AgentRpc)
      const events = yield* Stream.runCollect(client.Prompt({
        prompt: "Reply with exactly the word banana and nothing else.",
        sessionId: "live",
      }))

      const deltas = [...events]
        .filter((event) => event._tag === "TextDelta")
        .map((event) => event.delta)
        .join("")
      assert.ok(deltas.toLowerCase().includes("banana"), `expected banana, got: ${deltas}`)

      const finish = [...events].find((event) => event._tag === "Finish")
      assert.ok(finish !== undefined && finish.reason === "completed")
    }))
})
