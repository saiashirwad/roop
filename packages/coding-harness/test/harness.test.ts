import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { AgentRpc } from "@roop/agent-rpc/AgentRpc.ts"
import { AgentRpcClientHttp, AgentRpcServerHttp } from "@roop/agent-rpc/AgentRpcHttp.ts"
import { Agent } from "@roop/agent/Agent.ts"
import { cryptoWeb } from "@roop/agent/cryptoWeb.ts"
import { AgentPlugins, Plugin } from "@roop/agent/Plugin.ts"
import { SessionStoreMemory } from "@roop/agent/SessionStore.ts"
import { CodingTools } from "@roop/coding-tools/CodingTools.ts"
import { Effect, Layer, Ref, Stream } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import { RpcClient } from "effect/unstable/rpc"
import { afterAll } from "vitest"

const root = mkdtempSync(join(tmpdir(), "roop-harness-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const scripted = (turns: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>) =>
  Effect.gen(function* () {
    const index = yield* Ref.make(0)
    return yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () =>
        Stream.unwrap(
          Effect.gen(function* () {
            const i = yield* Ref.getAndUpdate(index, (n) => n + 1)
            /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
            return Stream.fromIterable((turns[i] ?? []) as never)
          }),
        ),
    })
  })

const agentLayer = (model: Effect.Effect<LanguageModel.Service>) =>
  AgentPlugins([
    CodingTools(root),
    Plugin({
      name: "fake-model",
      models: [
        { id: "fake", provider: "test", layer: Layer.effect(LanguageModel.LanguageModel, model) },
      ],
    }),
  ]).pipe(
    Layer.provide(SessionStoreMemory),
    Layer.provide(cryptoWeb),
    Layer.provide(NodeChildProcessSpawner.layer),
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(NodePath.layer),
  )

const turns: ReadonlyArray<ReadonlyArray<Record<string, unknown>>> = [
  [
    {
      type: "tool-call",
      id: "c1",
      name: "writeFile",
      params: { path: "hello.txt", content: "hi there" },
    },
  ],
  [{ type: "tool-call", id: "c2", name: "readFile", params: { path: "hello.txt" } }],
  [{ type: "tool-call", id: "c3", name: "bash", params: { command: "printf ok" } }],
  [{ type: "text-delta", id: "t1", delta: "done" }],
]

const expectedTags = [
  "ToolCall",
  "ToolResult",
  "ToolCall",
  "ToolResult",
  "ToolCall",
  "ToolResult",
  "TextDelta",
  "Finish",
]

it.layer(agentLayer(scripted(turns)))("coding harness", (it) => {
  it.effect("runs writeFile, readFile, and bash through the agent", () =>
    Effect.gen(function* () {
      const agent = yield* Agent
      const events = yield* Stream.runCollect(
        agent.prompt({ prompt: "do it", sessionId: "s1" }),
      ).pipe(Effect.map((chunk) => [...chunk]))

      assert.deepStrictEqual(
        events.map((event: any) => event._tag),
        expectedTags,
      )
      assert.strictEqual(readFileSync(join(root, "hello.txt"), "utf8"), "hi there")

      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      const read = events[3] as any
      assert.strictEqual(read.isFailure, false)
      assert.deepStrictEqual(read.result, { content: "hi there" })

      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      const bash = events[5] as any
      assert.strictEqual(bash.isFailure, false)
      assert.strictEqual(bash.result.exitCode, 0)
      assert.strictEqual(bash.result.stdout, "ok")
    }),
  )
})

it.effect("round-trips over HTTP RPC", () =>
  Effect.gen(function* () {
    const serverLayer = AgentRpcServerHttp("/rpc").pipe(Layer.provide(agentLayer(scripted(turns))))
    const { handler, dispose } = HttpRouter.toWebHandler(serverLayer, { disableLogger: true })
    yield* Effect.addFinalizer(() => Effect.promise(() => dispose()))
    const fetchWithHandler: typeof fetch = (input, init) =>
      handler(input instanceof Request ? input : new Request(input, init))
    const clientLayer = AgentRpcClientHttp("http://localhost/rpc").pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchWithHandler)),
    )
    const client = yield* RpcClient.make(AgentRpc).pipe(Effect.provide(clientLayer))

    const events = yield* Stream.runCollect(client.Prompt({ prompt: "do it", sessionId: "s-http" }))
    assert.deepStrictEqual(
      [...events].map((event) => event._tag),
      expectedTags,
    )
    assert.strictEqual(readFileSync(join(root, "hello.txt"), "utf8"), "hi there")
  }),
)
