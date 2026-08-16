import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { Agent } from "@roop/agent/Agent.ts"
import { cryptoWeb } from "@roop/agent/cryptoWeb.ts"
import { AgentPlugins, Plugin } from "@roop/agent/Plugin.ts"
import { SessionStoreMemory } from "@roop/agent/SessionStore.ts"
import { scripted } from "@roop/agent/Testing.ts"
import { Effect, FileSystem, Layer, Sink, Stream } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"

import { CodingTools } from "../src/CodingTools.ts"
import { ExecutionWorld } from "../src/ExecutionWorld.ts"

it.effect("ExecutionWorld: Node-backed ExecutionWorld executes file and bash tools", () =>
  Effect.gen(function* () {
    const agent = yield* Agent
    const events = yield* Stream.runCollect(
      agent.prompt({ prompt: "run", sessionId: "s-node" }),
    ).pipe(Effect.map((chunk) => [...chunk]))

    /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
    const toolResults = events.filter((e: any) => e._tag === "ToolResult") as ReadonlyArray<any>
    assert.strictEqual(toolResults.length, 3)
    assert.deepStrictEqual(toolResults[0].result, { path: "test.txt" })
    assert.deepStrictEqual(toolResults[1].result, { content: "node-world" })
    assert.deepStrictEqual(toolResults[2].result.stdout, "node-bash")
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "roop-layer-test-" })
          return AgentPlugins([
            CodingTools(root),
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
                          name: "writeFile",
                          params: { path: "test.txt", content: "node-world" },
                        },
                      ],
                      [
                        {
                          type: "tool-call",
                          id: "c2",
                          name: "readFile",
                          params: { path: "test.txt" },
                        },
                      ],
                      [
                        {
                          type: "tool-call",
                          id: "c3",
                          name: "bash",
                          params: { command: "printf 'node-bash'" },
                        },
                      ],
                      [{ type: "text-delta", id: "t1", delta: "done" }],
                    ]),
                  ),
                },
              ],
            }),
          ]).pipe(
            Layer.provide(SessionStoreMemory),
            Layer.provide(cryptoWeb),
            Layer.provide(ExecutionWorld.layer),
            Layer.provide(NodeFileSystem.layer),
            Layer.provide(NodeChildProcessSpawner.layer),
            Layer.provide(NodePath.layer),
          )
        }),
      ),
    ),
    Effect.provide([NodeFileSystem.layer, NodePath.layer]),
  ),
)

it.effect(
  "ExecutionWorld: swapping the ExecutionWorld layer moves filesystem and subprocess behavior together",
  () => {
    const virtualFiles = new Map<string, string>()
    virtualFiles.set("/virtual-root/demo.txt", "content from virtual world")

    const mockFileSystem = FileSystem.makeNoop({
      readFileString: (path: string) =>
        Effect.sync(() => {
          const content = virtualFiles.get(path)
          if (content === undefined) throw new Error(`file not found: ${path}`)
          return content
        }),
      writeFileString: (path: string, content: string) =>
        Effect.sync(() => {
          virtualFiles.set(path, content)
        }),
      readDirectory: () => Effect.succeed(["demo.txt"]),
    })

    const mockSpawner = ChildProcessSpawner.make((_command) =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(99999),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          stdin: Sink.drain,
          stdout: Stream.make(new TextEncoder().encode("output from virtual sandbox")),
          stderr: Stream.empty,
          all: Stream.make(new TextEncoder().encode("output from virtual sandbox")),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void),
        }),
      ),
    )

    const customExecutionWorldLayer = Layer.succeed(
      ExecutionWorld,
      ExecutionWorld.of({
        filesystem: mockFileSystem,
        spawner: mockSpawner,
      }),
    )

    return Effect.gen(function* () {
      const agent = yield* Agent
      const events = yield* Stream.runCollect(
        agent.prompt({ prompt: "run virtual", sessionId: "s-virtual" }),
      ).pipe(Effect.map((chunk) => [...chunk]))

      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      const toolResults = events.filter((e: any) => e._tag === "ToolResult") as ReadonlyArray<any>
      assert.strictEqual(toolResults.length, 2)

      assert.deepStrictEqual(toolResults[0].result, { content: "content from virtual world" })
      assert.strictEqual(toolResults[1].result.stdout, "output from virtual sandbox")
    }).pipe(
      Effect.provide(
        AgentPlugins([
          CodingTools("/virtual-root"),
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
                        name: "readFile",
                        params: { path: "demo.txt" },
                      },
                    ],
                    [
                      {
                        type: "tool-call",
                        id: "c2",
                        name: "bash",
                        params: { command: "echo hello" },
                      },
                    ],
                    [{ type: "text-delta", id: "t1", delta: "done" }],
                  ]),
                ),
              },
            ],
          }),
        ]).pipe(
          Layer.provide(SessionStoreMemory),
          Layer.provide(cryptoWeb),
          Layer.provide(customExecutionWorldLayer),
          Layer.provide(NodePath.layer),
        ),
      ),
    )
  },
)
