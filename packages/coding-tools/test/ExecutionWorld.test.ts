import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { Agent } from "@roop/agent/Agent.ts"
import { cryptoWeb } from "@roop/agent/cryptoWeb.ts"
import { AgentPlugins, Plugin } from "@roop/agent/Plugin.ts"
import { SessionJournalMemory } from "@roop/agent/SessionJournal.ts"
import { subagent } from "@roop/agent/subagent.ts"
import { scripted, scriptedPlugin } from "@roop/agent/Testing.ts"
import { Effect, FileSystem, Layer, Path, Stream } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"

import { CodingTools } from "../src/CodingTools.ts"
import { ExecutionWorld } from "../src/ExecutionWorld.ts"

const nodePlatform = Layer.mergeAll(
  NodeFileSystem.layer,
  NodeChildProcessSpawner.layer.pipe(
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(NodePath.layer),
  ),
  NodePath.layer,
)

it.effect("CodingTools.edit: applies targeted replacements and validates uniqueness", () =>
  Effect.gen(function* () {
    const agent = yield* Agent
    const events = yield* Stream.runCollect(
      agent.prompt({ prompt: "edit test", sessionId: "s-edit" }),
    ).pipe(Effect.map((chunk) => [...chunk]))

    /* SAFETY: the filter checks the discriminant before narrowing this test fixture. */
    const toolResults = events.filter((e: any) => e._tag === "ToolResult") as ReadonlyArray<any>
    assert.strictEqual(toolResults.length, 4)

    // Edit 1: single edit succeeds
    assert.strictEqual(toolResults[0].isFailure, false)
    assert.deepStrictEqual(toolResults[0].result, { path: "code.ts", appliedEdits: 1 })

    // Edit 2: multiple edits succeed
    assert.strictEqual(toolResults[1].isFailure, false)
    assert.deepStrictEqual(toolResults[1].result, { path: "code.ts", appliedEdits: 2 })

    // Edit 3: non-existent oldText fails with ToolFailure
    assert.strictEqual(toolResults[2].isFailure, true)
    assert.match(toolResults[2].result.message, /oldText not found/)

    // Edit 4: ambiguous (non-unique) oldText fails with ToolFailure
    assert.strictEqual(toolResults[3].isFailure, true)
    assert.match(toolResults[3].result.message, /matches 2 times/)
  }).pipe(
    Effect.provide(
      AgentPlugins([
        CodingTools(),
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
                      id: "e1",
                      name: "edit",
                      params: { path: "code.ts", oldText: "const x = 1", newText: "const x = 10" },
                    },
                  ],
                  [
                    {
                      type: "tool-call",
                      id: "e2",
                      name: "edit",
                      params: {
                        path: "code.ts",
                        edits: [
                          { oldText: "const y = 2", newText: "const y = 20" },
                          { oldText: "const z = 3", newText: "const z = 30" },
                        ],
                      },
                    },
                  ],
                  [
                    {
                      type: "tool-call",
                      id: "e3",
                      name: "edit",
                      params: { path: "code.ts", oldText: "nonExistent", newText: "replaced" },
                    },
                  ],
                  [
                    {
                      type: "tool-call",
                      id: "e4",
                      name: "edit",
                      params: { path: "code.ts", oldText: "aba", newText: "fixed" },
                    },
                  ],
                  [{ type: "text-delta", id: "t1", delta: "done" }],
                ]),
              ),
            },
          ],
        }),
      ]).pipe(
        Layer.provide(SessionJournalMemory),
        Layer.provide(cryptoWeb),
        Layer.provide(
          ExecutionWorld.memory({
            root: "/virtual",
            files: {
              "/virtual/code.ts": "const x = 1\nconst y = 2\nconst z = 3\nababa\n",
            },
          }),
        ),
        Layer.provide(NodePath.layer),
      ),
    ),
  ),
)

it.effect("CodingTools.find and grep: searches workspace file paths and line contents", () =>
  Effect.gen(function* () {
    const agent = yield* Agent
    const events = yield* Stream.runCollect(
      agent.prompt({ prompt: "search test", sessionId: "s-search" }),
    ).pipe(Effect.map((chunk) => [...chunk]))

    /* SAFETY: the filter checks the discriminant before narrowing this test fixture. */
    const toolResults = events.filter((e: any) => e._tag === "ToolResult") as ReadonlyArray<any>
    assert.strictEqual(toolResults.length, 4)

    // listFiles resolves entries relative to its nested target and omits ignored trees.
    assert.strictEqual(toolResults[0].isFailure, false)
    assert.deepStrictEqual(toolResults[0].result.files, ["src/index.ts", "src/util.ts"])

    // Find 1: glob find
    assert.strictEqual(toolResults[1].isFailure, false)
    assert.deepStrictEqual(toolResults[1].result.files, ["src/index.ts", "src/util.ts"])

    // Find 2: substring find
    assert.strictEqual(toolResults[2].isFailure, false)
    assert.deepStrictEqual(toolResults[2].result.files, ["src/util.ts"])

    // Grep: content grep with line numbers
    assert.strictEqual(toolResults[3].isFailure, false)
    assert.strictEqual(toolResults[3].result.totalMatches, 2)
    assert.deepStrictEqual(toolResults[3].result.matches[0], {
      file: "src/index.ts",
      line: 1,
      content: "export const hello = 'world'",
    })
    assert.deepStrictEqual(toolResults[3].result.matches[1], {
      file: "src/util.ts",
      line: 2,
      content: "export const world = 'hello'",
    })
  }).pipe(
    Effect.provide(
      AgentPlugins([
        CodingTools(),
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
                      id: "l1",
                      name: "listFiles",
                      params: { path: "src" },
                    },
                  ],
                  [
                    {
                      type: "tool-call",
                      id: "f1",
                      name: "find",
                      params: { pattern: "*.ts", path: "src" },
                    },
                  ],
                  [
                    {
                      type: "tool-call",
                      id: "f2",
                      name: "find",
                      params: { pattern: "util", path: "src" },
                    },
                  ],
                  [
                    {
                      type: "tool-call",
                      id: "g1",
                      name: "grep",
                      params: { pattern: "export const", path: "src" },
                    },
                  ],
                  [{ type: "text-delta", id: "t1", delta: "done" }],
                ]),
              ),
            },
          ],
        }),
      ]).pipe(
        Layer.provide(SessionJournalMemory),
        Layer.provide(cryptoWeb),
        Layer.provide(
          ExecutionWorld.memory({
            root: "/workspace",
            files: {
              "/workspace/src/index.ts": "export const hello = 'world'\nconsole.log('hi')",
              "/workspace/src/util.ts": "// helper\nexport const world = 'hello'",
              "/workspace/src/node_modules/ignored.ts": "export const ignored = true",
              "/workspace/src/.roop/cache.ts": "export const ignored = true",
              "/workspace/README.md": "# Readme",
            },
          }),
        ),
        Layer.provide(NodePath.layer),
      ),
    ),
  ),
)

it.effect("ExecutionWorld.local: Node-backed ExecutionWorld executes file and bash tools", () =>
  Effect.gen(function* () {
    const agent = yield* Agent
    const events = yield* Stream.runCollect(
      agent.prompt({ prompt: "run", sessionId: "s-node" }),
    ).pipe(Effect.map((chunk) => [...chunk]))

    /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
    /* SAFETY: the filter checks the discriminant before narrowing this test fixture. */
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
            CodingTools(),
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
            Layer.provide(SessionJournalMemory),
            Layer.provide(cryptoWeb),
            Layer.provide(ExecutionWorld.local(root)),
          )
        }),
      ).pipe(Layer.provideMerge(nodePlatform)),
    ),
  ),
)

it.effect("ExecutionWorld: prevents path escaping outside workspace root", () =>
  Effect.gen(function* () {
    const agent = yield* Agent
    const events = yield* Stream.runCollect(
      agent.prompt({ prompt: "escape", sessionId: "s-escape" }),
    ).pipe(Effect.map((chunk) => [...chunk]))

    /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
    const toolResults = events.filter((e: any) => e._tag === "ToolResult") as ReadonlyArray<any>
    assert.strictEqual(toolResults.length, 1)
    assert.strictEqual(toolResults[0].isFailure, true)
    assert.match(toolResults[0].result.message, /path escapes the workspace root/)
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "roop-escape-test-" })
          return AgentPlugins([
            CodingTools(),
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
                          params: { path: "../outside.txt" },
                        },
                      ],
                      [{ type: "text-delta", id: "t1", delta: "done" }],
                    ]),
                  ),
                },
              ],
            }),
          ]).pipe(
            Layer.provide(SessionJournalMemory),
            Layer.provide(cryptoWeb),
            Layer.provide(ExecutionWorld.local(root)),
          )
        }),
      ).pipe(Layer.provideMerge(nodePlatform)),
    ),
  ),
)

it.effect("ExecutionWorld: rejects symlink escapes for file and search tools", () =>
  Effect.gen(function* () {
    const agent = yield* Agent
    const events = yield* Stream.runCollect(
      agent.prompt({ prompt: "symlink escape", sessionId: "s-symlink-escape" }),
    ).pipe(Effect.map((chunk) => [...chunk]))

    /* SAFETY: the filter checks the discriminant before narrowing this test fixture. */
    const toolResults = events.filter((e: any) => e._tag === "ToolResult") as ReadonlyArray<any>
    assert.strictEqual(toolResults.length, 6)
    for (const result of toolResults) {
      assert.strictEqual(result.isFailure, true)
      assert.match(result.result.message, /path escapes the workspace root/)
    }
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "roop-symlink-root-" })
          const outside = yield* fs.makeTempDirectoryScoped({ prefix: "roop-symlink-outside-" })
          yield* fs.writeFileString(path.join(outside, "secret.txt"), "outside")
          yield* fs.symlink(outside, path.join(root, "link"))
          return AgentPlugins([
            CodingTools(),
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
                          id: "s1",
                          name: "readFile",
                          params: { path: "link/secret.txt" },
                        },
                      ],
                      [
                        {
                          type: "tool-call",
                          id: "s2",
                          name: "writeFile",
                          params: { path: "link/new.txt", content: "escape" },
                        },
                      ],
                      [
                        {
                          type: "tool-call",
                          id: "s3",
                          name: "edit",
                          params: {
                            path: "link/secret.txt",
                            oldText: "outside",
                            newText: "changed",
                          },
                        },
                      ],
                      [
                        {
                          type: "tool-call",
                          id: "s4",
                          name: "listFiles",
                          params: { path: "link" },
                        },
                      ],
                      [
                        {
                          type: "tool-call",
                          id: "s5",
                          name: "find",
                          params: { path: "link", pattern: "*.txt" },
                        },
                      ],
                      [
                        {
                          type: "tool-call",
                          id: "s6",
                          name: "grep",
                          params: { path: "link", pattern: "outside" },
                        },
                      ],
                      [{ type: "text-delta", id: "t1", delta: "done" }],
                    ]),
                  ),
                },
              ],
            }),
          ]).pipe(
            Layer.provide(SessionJournalMemory),
            Layer.provide(cryptoWeb),
            Layer.provide(ExecutionWorld.local(root)),
          )
        }),
      ).pipe(Layer.provideMerge(nodePlatform)),
    ),
  ),
)

it.effect("ExecutionWorld.memory: runs in-memory without host disk access", () =>
  Effect.gen(function* () {
    const agent = yield* Agent
    const events = yield* Stream.runCollect(
      agent.prompt({ prompt: "run in memory", sessionId: "s-memory" }),
    ).pipe(Effect.map((chunk) => [...chunk]))

    /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
    const toolResults = events.filter((e: any) => e._tag === "ToolResult") as ReadonlyArray<any>
    assert.strictEqual(toolResults.length, 3)
    assert.deepStrictEqual(toolResults[0].result, { content: "initial data" })
    assert.deepStrictEqual(toolResults[1].result, { path: "new-file.txt" })
    assert.strictEqual(toolResults[2].result.stdout, "output: echo memory")
  }).pipe(
    Effect.provide(
      AgentPlugins([
        CodingTools(),
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
                      params: { path: "init.txt" },
                    },
                  ],
                  [
                    {
                      type: "tool-call",
                      id: "c2",
                      name: "writeFile",
                      params: { path: "new-file.txt", content: "created in memory" },
                    },
                  ],
                  [
                    {
                      type: "tool-call",
                      id: "c3",
                      name: "bash",
                      params: { command: "echo memory" },
                    },
                  ],
                  [{ type: "text-delta", id: "t1", delta: "done" }],
                ]),
              ),
            },
          ],
        }),
      ]).pipe(
        Layer.provide(SessionJournalMemory),
        Layer.provide(cryptoWeb),
        Layer.provide(
          ExecutionWorld.memory({
            root: "/virtual-workspace",
            files: {
              "/virtual-workspace/init.txt": "initial data",
            },
          }),
        ),
        Layer.provide(NodePath.layer),
      ),
    ),
  ),
)

it.effect("ExecutionWorld.memory: fails missing files through error channel as ToolFailure", () =>
  Effect.gen(function* () {
    const agent = yield* Agent
    const events = yield* Stream.runCollect(
      agent.prompt({ prompt: "read missing file", sessionId: "s-memory-missing" }),
    ).pipe(Effect.map((chunk) => [...chunk]))

    /* SAFETY: the filter checks the discriminant before narrowing this test fixture. */
    const toolResults = events.filter((e: any) => e._tag === "ToolResult") as ReadonlyArray<any>
    assert.strictEqual(toolResults.length, 1)
    assert.strictEqual(toolResults[0].isFailure, true)
    assert.match(toolResults[0].result.message, /NotFound/)
  }).pipe(
    Effect.provide(
      AgentPlugins([
        CodingTools(),
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
                      params: { path: "nonexistent.txt" },
                    },
                  ],
                  [{ type: "text-delta", id: "t1", delta: "done" }],
                ]),
              ),
            },
          ],
        }),
      ]).pipe(
        Layer.provide(SessionJournalMemory),
        Layer.provide(cryptoWeb),
        Layer.provide(
          ExecutionWorld.memory({
            root: "/virtual-workspace",
            files: {},
          }),
        ),
        Layer.provide(NodePath.layer),
      ),
    ),
  ),
)

it.effect(
  "ExecutionWorld.worktree: Git worktree isolated ExecutionWorld creates and removes worktree on scope close",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const baseRepo = yield* fs.makeTempDirectoryScoped({ prefix: "roop-git-base-" })

      // Initialize git repo with an initial commit
      const exec = (args: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(ChildProcess.make("git", args, { cwd: baseRepo }))
          const exitCode = yield* handle.exitCode
          assert.strictEqual(Number(exitCode), 0)
        })

      yield* exec(["init"])
      yield* exec(["config", "user.name", "Roop Test"])
      yield* exec(["config", "user.email", "roop@test.local"])
      yield* fs.writeFileString(path.join(baseRepo, "README.md"), "# Base Repo")
      yield* exec(["add", "README.md"])
      yield* exec(["commit", "-m", "initial commit"])

      const worktreeDir = path.join(baseRepo, ".roop", "worktrees", "wt-test")

      // Run agent inside worktree scoped to this block
      yield* Effect.scoped(
        Effect.gen(function* () {
          const agentLayer = AgentPlugins([
            CodingTools(),
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
                          params: { path: "README.md" },
                        },
                      ],
                      [
                        {
                          type: "tool-call",
                          id: "c2",
                          name: "writeFile",
                          params: { path: "branch-file.txt", content: "branch data" },
                        },
                      ],
                      [{ type: "text-delta", id: "t1", delta: "done" }],
                    ]),
                  ),
                },
              ],
            }),
          ]).pipe(
            Layer.provide(SessionJournalMemory),
            Layer.provide(cryptoWeb),
            Layer.provide(
              ExecutionWorld.worktree({
                baseRepo,
                worktreeDir,
              }),
            ),
            Layer.provide(nodePlatform),
          )

          const scope = yield* Effect.scope
          const context = yield* Layer.buildWithScope(agentLayer, scope)

          const agent = yield* Agent.pipe(Effect.provide(context))
          const events = yield* Stream.runCollect(
            agent.prompt({ prompt: "worktree", sessionId: "s-wt" }),
          ).pipe(
            Effect.provide(context),
            Effect.map((chunk) => [...chunk]),
          )

          /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
          const toolResults = events.filter(
            (e: any) => e._tag === "ToolResult",
          ) as ReadonlyArray<any>
          assert.strictEqual(toolResults.length, 2)
          assert.deepStrictEqual(toolResults[0].result, { content: "# Base Repo" })
          assert.deepStrictEqual(toolResults[1].result, { path: "branch-file.txt" })

          // Check worktree dir exists while in scope
          assert.strictEqual(yield* fs.exists(worktreeDir), true)
        }),
      )

      // After scope close, worktree dir must be cleaned up
      assert.strictEqual(yield* fs.exists(worktreeDir), false)
    }).pipe(Effect.scoped, Effect.provide(nodePlatform)),
)

it.effect(
  "ExecutionWorld.worktree: fails with WorktreeError containing git error output when creation fails",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const emptyDir = yield* fs.makeTempDirectoryScoped({ prefix: "roop-not-git-" })

      const layer = ExecutionWorld.worktree({
        baseRepo: emptyDir,
      }).pipe(Layer.provide(nodePlatform))

      const result = yield* Layer.build(layer).pipe(Effect.scoped, Effect.flip)
      assert.strictEqual(result._tag, "WorktreeError")
      assert.match(result.message, /Failed to create git worktree/)
    }).pipe(Effect.scoped, Effect.provide(nodePlatform)),
)

it.effect(
  "subagent with ExecutionWorld.worktreeFromParent runs in an isolated worktree and cleans up on finish",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const baseRepo = yield* fs.makeTempDirectoryScoped({ prefix: "roop-subagent-base-" })

      const exec = (args: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          const handle = yield* spawner.spawn(ChildProcess.make("git", args, { cwd: baseRepo }))
          const exitCode = yield* handle.exitCode
          assert.strictEqual(Number(exitCode), 0)
        })

      yield* exec(["init"])
      yield* exec(["config", "user.name", "Roop Test"])
      yield* exec(["config", "user.email", "roop@test.local"])
      yield* fs.writeFileString(path.join(baseRepo, "README.md"), "# Base Repo")
      yield* exec(["add", "README.md"])
      yield* exec(["commit", "-m", "initial commit"])

      const worker = subagent({
        name: "Subagent",
        description: "delegate to subagent in worktree",
        plugins: [
          CodingTools(),
          scriptedPlugin("child-fake", [
            [
              {
                type: "tool-call",
                id: "w1",
                name: "writeFile",
                params: { path: "isolated-worktree.txt", content: "from isolated subagent" },
              },
            ],
            [{ type: "text-delta", id: "w2", delta: "subagent finished task" }],
          ]),
        ],
        layer: ExecutionWorld.worktreeFromParent(),
      })

      const parentLayer = AgentPlugins([
        CodingTools(),
        worker,
        Plugin({
          name: "parent-model",
          models: [
            {
              id: "parent-fake",
              provider: "test",
              layer: Layer.effect(
                LanguageModel.LanguageModel,
                scripted([
                  [
                    {
                      type: "tool-call",
                      id: "p1",
                      name: "Subagent",
                      params: { task: "write file in worktree" },
                    },
                  ],
                  [{ type: "text-delta", id: "p2", delta: "parent completed" }],
                ]),
              ),
            },
          ],
        }),
      ]).pipe(
        Layer.provide(SessionJournalMemory),
        Layer.provide(cryptoWeb),
        Layer.provide(ExecutionWorld.local(baseRepo)),
        Layer.provide(nodePlatform),
      )

      const events = yield* Effect.gen(function* () {
        const agent = yield* Agent
        return yield* Stream.runCollect(
          agent.prompt({ prompt: "run subagent", sessionId: "s-parent-subagent" }),
        ).pipe(Effect.map((chunk) => [...chunk]))
      }).pipe(Effect.provide(parentLayer))

      /* SAFETY: the filter checks the discriminant before narrowing this test fixture. */
      const toolResults = events.filter((e: any) => e._tag === "ToolResult") as ReadonlyArray<any>
      assert.strictEqual(toolResults.length, 1)
      assert.deepStrictEqual(toolResults[0].result, { summary: "subagent finished task" })

      const childWrites = events
        .filter((e: any) => e._tag === "Subagent")
        .map((e: any) => e.event)
        .filter((e: any) => e._tag === "ToolResult" && e.name === "writeFile")
      assert.strictEqual(childWrites.length, 1)
      assert.strictEqual(childWrites[0].isFailure, false)
      assert.deepStrictEqual(childWrites[0].result, { path: "isolated-worktree.txt" })

      // File created in worktree should not exist in parent base repo
      assert.strictEqual(yield* fs.exists(path.join(baseRepo, "isolated-worktree.txt")), false)

      // No leaked worktrees
      const worktreeDir = path.join(baseRepo, ".roop", "worktrees")
      if (yield* fs.exists(worktreeDir)) {
        const remaining = yield* fs.readDirectory(worktreeDir)
        assert.strictEqual(remaining.length, 0)
      }
    }).pipe(Effect.scoped, Effect.provide(nodePlatform)),
)
