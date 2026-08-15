import { assert, it } from "@effect/vitest"
import { Agent } from "@roop/agent/Agent.ts"
import { cryptoWeb } from "@roop/agent/cryptoWeb.ts"
import { AgentPlugins, Plugin } from "@roop/agent/Plugin.ts"
import { SessionStoreMemory } from "@roop/agent/SessionStore.ts"
import { scripted } from "@roop/agent/Testing.ts"
import { Effect, Layer, Stream } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"

import { WebTools } from "../src/WebTools.ts"

const fakeFetch: typeof fetch = () =>
  Promise.resolve(new Response("hello from the web", { status: 200 }))

const Main = AgentPlugins([
  WebTools({ maxLength: 10 }),
  Plugin({
    name: "model",
    models: [
      {
        id: "fake",
        provider: "test",
        layer: Layer.effect(
          LanguageModel.LanguageModel,
          scripted([
            [
              {
                type: "tool-call",
                id: "c1",
                name: "webFetch",
                params: { url: "https://example.com" },
              },
            ],
            [{ type: "text-delta", id: "t1", delta: "fetched" }],
          ]),
        ),
      },
    ],
  }),
]).pipe(
  Layer.provide(SessionStoreMemory),
  Layer.provide(cryptoWeb),
  Layer.provide(
    FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fakeFetch))),
  ),
)

it.layer(Main)("WebTools", (it) => {
  it.effect("fetches a url and truncates the body", () =>
    Effect.gen(function* () {
      const agent = yield* Agent
      const events = yield* Stream.runCollect(agent.prompt({ prompt: "go", sessionId: "w1" })).pipe(
        Effect.map((chunk) => [...chunk]),
      )
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      const result = events.find((event: any) => event._tag === "ToolResult") as any
      assert.strictEqual(result.isFailure, false)
      assert.deepStrictEqual(result.result, {
        status: 200,
        body: "hello from",
        truncated: true,
      })
    }),
  )
})
