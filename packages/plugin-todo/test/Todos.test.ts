import { assert, it } from "@effect/vitest"
import { Agent } from "@roop/agent/Agent.ts"
import { cryptoWeb } from "@roop/agent/cryptoWeb.ts"
import { AgentPlugins, Plugin } from "@roop/agent/Plugin.ts"
import { deriveMessages } from "@roop/agent/SessionEvent.ts"
import { SessionStoreMemory } from "@roop/agent/SessionStore.ts"
import { Effect, Layer, Ref, Stream } from "effect"
import { LanguageModel, Response } from "effect/unstable/ai"

import { Todos } from "../src/Todos.ts"

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

const plan = [
  { text: "write the file", state: "active" },
  { text: "verify it", state: "pending" },
]

const Main = AgentPlugins([
  Todos(),
  Plugin({
    name: "model",
    models: [
      {
        id: "fake",
        provider: "test",
        layer: Layer.effect(
          LanguageModel.LanguageModel,
          scripted([
            [{ type: "tool-call", id: "c1", name: "writeTodos", params: { todos: plan } }],
            [{ type: "text-delta", id: "t1", delta: "planned" }],
          ]),
        ),
      },
    ],
  }),
]).pipe(Layer.provide(SessionStoreMemory), Layer.provide(cryptoWeb))

it.layer(Main)("Todos", (it) => {
  it.effect("stores the plan and instructs the model", () =>
    Effect.gen(function* () {
      const agent = yield* Agent

      const caps = yield* agent.capabilities
      assert.deepStrictEqual(
        caps.tools.map((tool) => tool.name),
        ["writeTodos"],
      )

      const events = yield* Stream.runCollect(agent.prompt({ prompt: "go", sessionId: "t1" })).pipe(
        Effect.map((chunk) => [...chunk]),
      )
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      const result = events.find((event: any) => event._tag === "ToolResult") as any
      assert.strictEqual(result.isFailure, false)
      assert.deepStrictEqual(result.result, { todos: plan })

      const session = yield* agent.history("t1")
      assert.strictEqual(deriveMessages(session.events)[0]!.role, "system")
    }),
  )
})
