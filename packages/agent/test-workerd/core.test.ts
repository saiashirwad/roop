import { assert, it } from "@effect/vitest"
import { Effect, Ref, Schema, Stream } from "effect"
import { LanguageModel, type Response, Tool } from "effect/unstable/ai"

import { Agent } from "../src/Agent.ts"
import { JournalMemory } from "../src/JournalMemory.ts"
import { Module } from "../src/Module.ts"
import { runAgent } from "../src/Runtime.ts"

const Ping = Tool.make("ping", {
  description: "reply with ok",
  parameters: Schema.Struct({}),
  success: Schema.Struct({ ok: Schema.Boolean }),
})

const scripted = (turns: ReadonlyArray<ReadonlyArray<Response.StreamPartEncoded>>) =>
  Effect.gen(function* () {
    const index = yield* Ref.make(0)
    return yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () =>
        Stream.unwrap(
          Effect.gen(function* () {
            const current = yield* Ref.getAndUpdate(index, (value) => value + 1)
            return Stream.fromIterable(turns[current] ?? [])
          }),
        ),
    })
  })

it.effect("core runs inside workerd", () =>
  Effect.gen(function* () {
    yield* Schema.decodeUnknownEffect(Schema.Struct({ caches: Schema.Unknown }))(globalThis)
    const model = yield* scripted([
      [{ type: "tool-call", id: "c", name: "ping", params: {} }],
      [{ type: "text-delta", id: "t", delta: "done" }],
    ])
    const agent = Agent.make(
      "workerd",
      Module.tool(Ping, () => Effect.succeed({ ok: true })),
    )
    const events = yield* runAgent(agent, { prompt: "ping it", sessionId: "w" }).pipe(
      Stream.runCollect,
      Effect.provide(JournalMemory),
      Effect.provideService(LanguageModel.LanguageModel, model),
    )
    assert.deepStrictEqual(
      [...events].map((event) => event._tag),
      ["ToolCall", "ToolResult", "TextDelta", "Finish"],
    )
  }),
)
