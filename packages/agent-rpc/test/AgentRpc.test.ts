import { assert, it } from "@effect/vitest"
import { AgentLiveToolkit } from "@roop/agent/Agent.ts"
import { ModelCatalogLive } from "@roop/agent/ModelCatalog.ts"
import { SessionStoreMemory } from "@roop/agent/SessionStore.ts"
import { Skills } from "@roop/agent/Skills.ts"
import { Effect, Exit, Layer, Option, Ref, Schema, Stream } from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai"
import * as RpcTest from "effect/unstable/rpc/RpcTest"

import { AgentRpc } from "../src/AgentRpc.ts"
import { AgentRpcServer } from "../src/AgentRpcServer.ts"

const Echo = Tool.make("echo", {
  description: "echo a note back",
  parameters: Schema.Struct({ note: Schema.String }),
  success: Schema.Struct({ reply: Schema.String }),
})

const EchoToolkit = Toolkit.make(Echo)

const scripted = (turns: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>) =>
  Effect.gen(function* () {
    const index = yield* Ref.make(0)
    return yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () =>
        Stream.unwrap(
          Effect.gen(function* () {
            const i = yield* Ref.getAndUpdate(index, (n) => n + 1)
            return Stream.fromIterable((turns[i] ?? []) as never)
          }),
        ),
    })
  })

const TestLayer = AgentLiveToolkit(EchoToolkit).pipe(
  Layer.provide(
    ModelCatalogLive([
      {
        id: "deepseek-chat",
        provider: "deepseek",
        layer: Layer.effect(
          LanguageModel.LanguageModel,
          scripted([
            [{ type: "tool-call" as const, id: "c1", name: "echo", params: { note: "hi" } }],
            [{ type: "text-delta" as const, id: "t1", delta: "done" }],
          ]),
        ),
      },
    ]),
  ),
  Layer.provide(SessionStoreMemory),
  Layer.provide(
    EchoToolkit.toLayer({
      echo: ({ note }) => Effect.succeed({ reply: note }),
    }),
  ),
  Layer.provide(
    Layer.succeed(Skills, {
      list: [{ id: "summarize", description: "summarize text" }],
    }),
  ),
)

it.layer(AgentRpcServer.pipe(Layer.provide(TestLayer)))("AgentRpc", (it) => {
  it.effect("serves capabilities derived from toolkit, catalog, and skills", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(AgentRpc)
      const caps = yield* client.Capabilities()

      assert.deepStrictEqual(
        caps.tools.map((tool) => tool.name),
        ["echo"],
      )
      assert.deepStrictEqual(
        caps.models.map((model) => model.id),
        ["deepseek-chat"],
      )
      assert.strictEqual(caps.defaultModelId, "deepseek-chat")
      assert.deepStrictEqual(
        caps.skills.map((skill) => skill.id),
        ["summarize"],
      )
      const parameters = caps.tools[0]!.parameters as any
      assert.deepStrictEqual(Object.keys(parameters.properties ?? {}), ["note"])
    }),
  )

  it.effect("streams prompt deltas and tool round-trips", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(AgentRpc)
      const events = yield* Stream.runCollect(client.Prompt({ prompt: "say hi", sessionId: "s1" }))

      assert.deepStrictEqual(
        [...events].map((event) => event._tag),
        ["ToolCall", "ToolResult", "TextDelta", "Finish"],
      )
      const history = yield* client.GetHistory({ sessionId: "s1" })
      assert.deepStrictEqual(
        history.messages.map((message) => message.role),
        ["user", "assistant", "tool"],
      )
    }),
  )

  it.effect("propagates protocol errors through the typed error channel", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(AgentRpc)

      const modelExit = yield* Effect.exit(
        Stream.runDrain(
          client.Prompt({
            prompt: "hi",
            sessionId: "s2",
            modelId: "nope",
          }),
        ),
      )
      assert.strictEqual(
        (Option.getOrThrow(Exit.findErrorOption(modelExit)) as any)._tag,
        "ModelNotFound",
      )

      const interruptExit = yield* Effect.exit(client.Interrupt({ sessionId: "nope" }))
      assert.strictEqual(
        (Option.getOrThrow(Exit.findErrorOption(interruptExit)) as any)._tag,
        "RunNotFound",
      )

      const historyExit = yield* Effect.exit(client.GetHistory({ sessionId: "nope" }))
      assert.strictEqual(
        (Option.getOrThrow(Exit.findErrorOption(historyExit)) as any)._tag,
        "SessionNotFound",
      )
    }),
  )
})
