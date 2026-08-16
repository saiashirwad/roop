import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { Agent } from "@roop/agent/Agent.ts"
import { cryptoWeb } from "@roop/agent/cryptoWeb.ts"
import { AgentPlugins, Plugin } from "@roop/agent/Plugin.ts"
import { SessionStoreMemory } from "@roop/agent/SessionStore.ts"
import { scripted } from "@roop/agent/Testing.ts"
import { CodingTools } from "@roop/coding-tools/CodingTools.ts"
import { ExecutionWorld } from "@roop/coding-tools/ExecutionWorld.ts"
import { Effect, FileSystem, Layer, Path, Stream } from "effect"
import { LanguageModel, type Response } from "effect/unstable/ai"

import { parsePort } from "../src/parsePort.ts"

const agentLayer = (model: Effect.Effect<LanguageModel.Service>, root: string) =>
  AgentPlugins([
    CodingTools(),
    Plugin({
      name: "fake-model",
      models: [
        { id: "fake", provider: "test", layer: Layer.effect(LanguageModel.LanguageModel, model) },
      ],
    }),
  ]).pipe(
    Layer.provide(SessionStoreMemory),
    Layer.provide(cryptoWeb),
    Layer.provide(ExecutionWorld.local(root)),
    Layer.provide(NodeChildProcessSpawner.layer),
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(NodePath.layer),
  )

const withWorkspace = <A, E, R>(run: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "roop-harness-" })
    return yield* run(root)
  }).pipe(Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)))

const turns: ReadonlyArray<ReadonlyArray<Response.StreamPartEncoded>> = [
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

it.effect("parsePort rejects malformed and out-of-range ports", () =>
  Effect.gen(function* () {
    assert.strictEqual(yield* parsePort("1"), 1)
    assert.strictEqual(yield* parsePort("65535"), 65535)
    for (const value of ["0", "65536", "1.5", "NaN", "-1", "0x10", "1e3", " 8080 "]) {
      const error = yield* parsePort(value).pipe(Effect.flip)
      assert.match(error.message, /expected an integer from 1 to 65535/)
    }
  }),
)

it.effect("runs writeFile, readFile, and bash through the agent", () =>
  withWorkspace((root) =>
    Effect.gen(function* () {
      const agent = yield* Agent
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const events = yield* Stream.runCollect(
        agent.prompt({ prompt: "do it", sessionId: "s1" }),
      ).pipe(Effect.map((chunk) => [...chunk]))

      assert.deepStrictEqual(
        events.map((event: any) => event._tag),
        expectedTags,
      )
      assert.strictEqual(yield* fs.readFileString(path.join(root, "hello.txt")), "hi there")

      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      const read = events[3] as any
      assert.strictEqual(read.isFailure, false)
      assert.deepStrictEqual(read.result, { content: "hi there" })

      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      const bash = events[5] as any
      assert.strictEqual(bash.isFailure, false)
      assert.strictEqual(bash.result.exitCode, 0)
      assert.strictEqual(bash.result.stdout, "ok")
    }).pipe(Effect.provide(agentLayer(scripted(turns), root))),
  ),
)
