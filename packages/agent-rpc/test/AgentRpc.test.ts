import { NodeFileSystem } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { AgentLiveToolkit } from "@roop/agent/Agent.ts"
import { cryptoWeb } from "@roop/agent/cryptoWeb.ts"
import { deriveMessages } from "@roop/agent/SessionEvent.ts"
import { SessionStoreFs, SessionStoreMemory } from "@roop/agent/SessionStore.ts"
import { scripted } from "@roop/agent/Testing.ts"
import { Effect, Exit, FileSystem, Layer, Option, Schema, Stream } from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import { RpcClient } from "effect/unstable/rpc"
import * as RpcTest from "effect/unstable/rpc/RpcTest"

import { AgentRpc } from "../src/AgentRpc.ts"
import { AgentRpcClientHttp, AgentRpcServerHttp } from "../src/AgentRpcHttp.ts"
import { AgentRpcServer } from "../src/AgentRpcServer.ts"

const Echo = Tool.make("echo", {
  description: "echo a note back",
  parameters: Schema.Struct({ note: Schema.String }),
  success: Schema.Struct({ reply: Schema.String }),
})

const EchoToolkit = Toolkit.make(Echo)

const TestLayer = AgentLiveToolkit(EchoToolkit, {
  models: [
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
  ],
  skills: [{ id: "summarize", description: "summarize text" }],
}).pipe(
  Layer.provide(SessionStoreMemory),
  Layer.provide(cryptoWeb),
  Layer.provide(
    EchoToolkit.toLayer({
      echo: ({ note }) => Effect.succeed({ reply: note }),
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
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
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
        deriveMessages(history.events).map((message) => message.role),
        ["user", "assistant", "tool"],
      )

      const sessions = yield* client.ListSessions()
      assert.deepStrictEqual(
        sessions.map((meta) => [meta.id, meta.title]),
        [["s1", "say hi"]],
      )

      const forkedMeta = yield* client.ForkSession({ fromSessionId: "s1", toSessionId: "s1-fork" })
      assert.strictEqual(forkedMeta.id, "s1-fork")
      assert.strictEqual(forkedMeta.title, "say hi")

      const forkedHistory = yield* client.GetHistory({ sessionId: "s1-fork" })
      assert.deepStrictEqual(
        deriveMessages(forkedHistory.events).map((message) => message.role),
        ["user", "assistant", "tool"],
      )

      const duplicateFork = yield* Effect.exit(
        client.ForkSession({ fromSessionId: "s1", toSessionId: "s1-fork" }),
      )
      assert.ok(Exit.isFailure(duplicateFork))
      /* SAFETY: Exit.findErrorOption is present after the preceding failure assertion. */
      assert.strictEqual(
        (Option.getOrThrow(Exit.findErrorOption(duplicateFork)) as any)._tag,
        "SessionAlreadyExists",
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
      /* SAFETY: The invalid model id deterministically yields ModelNotFound. */
      assert.strictEqual(
        (Option.getOrThrow(Exit.findErrorOption(modelExit)) as any)._tag,
        "ModelNotFound",
      )

      const interruptExit = yield* Effect.exit(client.Interrupt({ sessionId: "nope" }))
      /* SAFETY: Interrupting the unknown session deterministically yields RunNotFound. */
      assert.strictEqual(
        (Option.getOrThrow(Exit.findErrorOption(interruptExit)) as any)._tag,
        "RunNotFound",
      )

      const historyExit = yield* Effect.exit(client.GetHistory({ sessionId: "nope" }))
      /* SAFETY: Reading the unknown session deterministically yields SessionNotFound. */
      assert.strictEqual(
        (Option.getOrThrow(Exit.findErrorOption(historyExit)) as any)._tag,
        "SessionNotFound",
      )
    }),
  )
})

const corruptSessionStore = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const dir = yield* fs.makeTempDirectory({ prefix: "agentrpc-corrupt-" })
  yield* fs.writeFileString(`${dir}/corrupt.json`, "{ not json")
  return SessionStoreFs(dir)
}).pipe(Effect.orDie)

const FsTestLayer = AgentLiveToolkit(EchoToolkit, {
  models: [
    {
      id: "deepseek-chat",
      provider: "deepseek",
      layer: Layer.effect(
        LanguageModel.LanguageModel,
        scripted([[{ type: "text-delta" as const, id: "t1", delta: "done" }]]),
      ),
    },
  ],
}).pipe(
  Layer.provide(Layer.unwrap(corruptSessionStore)),
  Layer.provide(NodeFileSystem.layer),
  Layer.provide(cryptoWeb),
  Layer.provide(
    EchoToolkit.toLayer({
      echo: ({ note }) => Effect.succeed({ reply: note }),
    }),
  ),
)

it.layer(AgentRpcServer.pipe(Layer.provide(FsTestLayer)))("AgentRpc corrupt session", (it) => {
  it.effect("surfaces SessionFormatError from the prompt stream as an RPC error", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(AgentRpc)

      const exit = yield* Effect.exit(
        Stream.runDrain(client.Prompt({ prompt: "hi", sessionId: "corrupt" })),
      )
      assert.ok(Exit.isFailure(exit))
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      const failure = Option.getOrThrow(Exit.findErrorOption(exit)) as any
      assert.strictEqual(failure._tag, "SessionFormatError")
      assert.strictEqual(failure.sessionId, "corrupt")
    }),
  )
})

it.layer(AgentRpcServer.pipe(Layer.provide(TestLayer)))("AgentRpc over HTTP", (it) => {
  it.effect("round-trips over the HTTP transport", () =>
    Effect.gen(function* () {
      const serverLayer = AgentRpcServerHttp("/rpc").pipe(Layer.provide(TestLayer))
      const { handler, dispose } = HttpRouter.toWebHandler(serverLayer, { disableLogger: true })
      yield* Effect.addFinalizer(() => Effect.promise(() => dispose()))
      const fetchWithHandler: typeof fetch = (input, init) =>
        handler(input instanceof Request ? input : new Request(input, init))
      const clientLayer = AgentRpcClientHttp("http://localhost/rpc").pipe(
        Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchWithHandler)),
      )
      const client = yield* RpcClient.make(AgentRpc).pipe(Effect.provide(clientLayer))
      const events = yield* Stream.runCollect(
        client.Prompt({ prompt: "say hi", sessionId: "s-http" }),
      )

      assert.deepStrictEqual(
        [...events].map((event) => event._tag),
        ["ToolCall", "ToolResult", "TextDelta", "Finish"],
      )
    }),
  )
})
