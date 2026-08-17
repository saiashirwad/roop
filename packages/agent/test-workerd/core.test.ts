import { assert, it } from "@effect/vitest"
import { Effect, Layer, Ref, Schema, Stream } from "effect"
import { LanguageModel, type Response, Tool, Toolkit } from "effect/unstable/ai"

import { Agent, AgentLiveToolkit } from "../src/Agent.ts"
import { cryptoWeb } from "../src/cryptoWeb.ts"
import { SessionJournalMemory } from "../src/SessionJournal.ts"

const Ping = Tool.make("ping", {
  description: "reply with ok",
  parameters: Schema.Struct({}),
  success: Schema.Struct({ ok: Schema.Boolean }),
})

const PingToolkit = Toolkit.make(Ping)

const scripted = (turns: ReadonlyArray<ReadonlyArray<Response.StreamPartEncoded>>) =>
  Effect.gen(function* () {
    const index = yield* Ref.make(0)
    return yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () =>
        Stream.unwrap(
          Effect.gen(function* () {
            const i = yield* Ref.getAndUpdate(index, (n) => n + 1)
            return Stream.fromIterable(turns[i] ?? [])
          }),
        ),
    })
  })

const Live = AgentLiveToolkit(PingToolkit, {
  models: [
    {
      id: "tool",
      provider: "test",
      layer: Layer.effect(
        LanguageModel.LanguageModel,
        scripted([
          [{ type: "tool-call" as const, id: "c", name: "ping", params: {} }],
          [{ type: "text-delta" as const, id: "t", delta: "done" }],
        ]),
      ),
    },
  ],
}).pipe(
  Layer.provide(SessionJournalMemory),
  Layer.provide(cryptoWeb),
  Layer.provide(
    PingToolkit.toLayer({
      ping: () => Effect.succeed({ ok: true }),
    }),
  ),
)

it.effect("core runs inside workerd", () =>
  Effect.gen(function* () {
    yield* Schema.decodeUnknownEffect(Schema.Struct({ caches: Schema.Unknown }))(globalThis)

    const agent = yield* Agent
    const events = yield* Stream.runCollect(agent.prompt({ prompt: "ping it", sessionId: "w" }))

    assert.deepStrictEqual(
      [...events].map((event) => event._tag),
      ["ToolCall", "ToolResult", "TextDelta", "Finish"],
    )
  }).pipe(Effect.provide(Live)),
)
