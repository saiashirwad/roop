import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node"
import { assert, describe, expect, it } from "@effect/vitest"
import { Agent } from "@roop/agent/Agent.ts"
import type { AgentEvent } from "@roop/agent/AgentEvents.ts"
import { cryptoWeb } from "@roop/agent/cryptoWeb.ts"
import { AgentPlugins, Plugin } from "@roop/agent/Plugin.ts"
import { SessionJournalMemory } from "@roop/agent/SessionJournal.ts"
import { scripted } from "@roop/agent/Testing.ts"
import { Effect, FileSystem, Layer, Path, Stream } from "effect"
import { LanguageModel } from "effect/unstable/ai"

import {
  applyPatchTransaction,
  normalizePatchText,
  parsePatch,
  patchContent,
} from "../src/ApplyPatch.ts"
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

type ToolResult = Extract<AgentEvent, { readonly _tag: "ToolResult" }>
const isToolResult = (event: AgentEvent): event is ToolResult => event._tag === "ToolResult"

describe("ApplyPatch - Parser & Matcher", () => {
  it("normalizes patch text and strips markdown fences and heredocs", () => {
    const raw = [
      "```diff",
      "cat <<'EOF'",
      "*** Begin Patch",
      "*** Add File: hello.txt",
      "+Hello world",
      "*** End Patch",
      "EOF",
      "```",
    ].join("\n")

    expect(normalizePatchText(raw)).toBe(
      ["*** Begin Patch", "*** Add File: hello.txt", "+Hello world", "*** End Patch"].join("\n"),
    )
  })

  it("applies raw hunks to content", () => {
    expect(patchContent("sample.txt", "line1\nline2\n", "@@\n-line2\n+changed")).toBe(
      "line1\nchanged\n",
    )
  })

  it("does not treat raw marker text as a wrapped patch", () => {
    expect(
      patchContent(
        "sample.txt",
        "*** Begin Patch\nfinish\n",
        "@@\n-*** Begin Patch\n+*** End Patch",
      ),
    ).toBe("*** End Patch\nfinish\n")
  })

  it("parses wrapped single-file patches", () => {
    expect(
      patchContent(
        "sample.txt",
        "alpha\nomega\n",
        "*** Begin Patch\n*** Update File: ignored.txt\n@@\n alpha\n+beta\n omega\n*** End Patch",
      ),
    ).toBe("alpha\nbeta\nomega\n")
  })

  it("parses wrapped patches without an explicit end marker at EOF", () => {
    expect(
      parsePatch(
        [
          "*** Begin Patch",
          "*** Update File: src/ExaSearch.ts",
          "@@",
          " export class ExaSearch extends Context.Service<",
          "   ExaSearch,",
          "   {",
          "-    search(query: string): Effect.Effect<Array<SearchResponse<{}>>, ExaError>",
          "+    search(query: string): Effect.Effect<SearchResponse<{}>, ExaError>",
          "   }",
          ' >()("clanka/ExaSearch") {}',
        ].join("\n"),
      ),
    ).toEqual([
      {
        type: "update",
        path: "src/ExaSearch.ts",
        chunks: [
          {
            old: [
              "export class ExaSearch extends Context.Service<",
              "  ExaSearch,",
              "  {",
              "    search(query: string): Effect.Effect<Array<SearchResponse<{}>>, ExaError>",
              "  }",
              '>()("clanka/ExaSearch") {}',
            ],
            next: [
              "export class ExaSearch extends Context.Service<",
              "  ExaSearch,",
              "  {",
              "    search(query: string): Effect.Effect<SearchResponse<{}>, ExaError>",
              "  }",
              '>()("clanka/ExaSearch") {}',
            ],
          },
        ],
      },
    ])
  })

  it("parses multi-file wrapped patches", () => {
    expect(
      parsePatch(
        [
          "*** Begin Patch",
          "*** Add File: hello.txt",
          "+Hello world",
          "*** Update File: src/app.ts",
          "*** Move to: src/main.ts",
          "@@ keep",
          " keep",
          "-old",
          "+new",
          "*** Delete File: obsolete.txt",
          "*** End Patch",
        ].join("\n"),
      ),
    ).toEqual([
      {
        type: "add",
        path: "hello.txt",
        content: "Hello world",
      },
      {
        type: "update",
        path: "src/app.ts",
        movePath: "src/main.ts",
        chunks: [
          {
            ctx: "keep",
            old: ["keep", "old"],
            next: ["keep", "new"],
          },
        ],
      },
      {
        type: "delete",
        path: "obsolete.txt",
      },
    ])
  })

  it("parses wrapped patches when hunks contain marker text", () => {
    expect(
      parsePatch(
        [
          "*** Begin Patch",
          "*** Update File: src/app.ts",
          "@@",
          " *** End Patch",
          "-old",
          "+new",
          "*** Delete File: obsolete.txt",
          "*** End Patch",
        ].join("\n"),
      ),
    ).toEqual([
      {
        type: "update",
        path: "src/app.ts",
        chunks: [
          {
            old: ["*** End Patch", "old"],
            next: ["*** End Patch", "new"],
          },
        ],
      },
      {
        type: "delete",
        path: "obsolete.txt",
      },
    ])
  })

  it("parses multi-file git diffs with add, rename, and delete", () => {
    expect(
      parsePatch(
        [
          "diff --git a/src/app.ts b/src/app.ts",
          "--- a/src/app.ts",
          "+++ b/src/app.ts",
          "@@ -1 +1 @@",
          "-old",
          "+new",
          "diff --git a/obsolete.txt b/obsolete.txt",
          "deleted file mode 100644",
          "--- a/obsolete.txt",
          "+++ /dev/null",
          "diff --git a/src/old.ts b/src/new.ts",
          "similarity index 100%",
          "rename from src/old.ts",
          "rename to src/new.ts",
          "--- a/src/old.ts",
          "+++ b/src/new.ts",
          "@@ -1 +1 @@",
          "-before",
          "+after",
          "diff --git a/dev/null b/notes/hello.txt",
          "new file mode 100644",
          "--- /dev/null",
          "+++ b/notes/hello.txt",
          "@@ -0,0 +1 @@",
          "+Hello world",
        ].join("\n"),
      ),
    ).toEqual([
      {
        type: "update",
        path: "src/app.ts",
        chunks: [
          {
            old: ["old"],
            next: ["new"],
          },
        ],
      },
      {
        type: "delete",
        path: "obsolete.txt",
      },
      {
        type: "update",
        path: "src/old.ts",
        movePath: "src/new.ts",
        chunks: [
          {
            old: ["before"],
            next: ["after"],
          },
        ],
      },
      {
        type: "add",
        path: "notes/hello.txt",
        content: "Hello world\n",
      },
    ])
  })

  it("parses unified diffs without a diff --git header", () => {
    expect(
      parsePatch(
        ["--- a/sample.txt", "+++ b/sample.txt", "@@ -1 +1,2 @@", " alpha", "+beta"].join("\n"),
      ),
    ).toEqual([
      {
        type: "update",
        path: "sample.txt",
        chunks: [
          {
            old: ["alpha"],
            next: ["alpha", "beta"],
          },
        ],
      },
    ])
  })

  it("4-tier fuzzy matcher matches across tiers", () => {
    // Tier 1: exact
    expect(patchContent("t1.txt", "exact line\n", "@@\n-exact line\n+new line")).toBe("new line\n")

    // Tier 2: trimEnd() trailing whitespace
    expect(
      patchContent("t2.txt", "trailing whitespace  \n", "@@\n-trailing whitespace\n+fixed"),
    ).toBe("fixed\n")

    // Tier 3: trim() leading indentation drift
    expect(
      patchContent("t3.txt", "    indented code\n", "@@\n-  indented code\n+    clean code"),
    ).toBe("    clean code\n")

    // Tier 4: Unicode normalization (quotes, dashes, nbsp, ellipsis)
    expect(
      patchContent(
        "t4.txt",
        "const msg = “Don’t—stop…\u00A0now”\n",
        '@@\n-const msg = "Don\'t-stop... now"\n+const msg = "done"',
      ),
    ).toBe('const msg = "done"\n')
  })

  it("uses context to disambiguate repeated matches", () => {
    expect(
      patchContent(
        "sample.txt",
        ["before", "target", "old", "between", "target", "old", "after", ""].join("\n"),
        ["@@ target", " target", "-old", "+new"].join("\n"),
      ),
    ).toBe("before\ntarget\nold\nbetween\ntarget\nnew\nafter\n")
  })

  it("matches EOF hunks from the end of the file", () => {
    expect(
      patchContent(
        "tail.txt",
        "start\nmarker\nend\nmiddle\nmarker\nend\n",
        "@@\n-marker\n-end\n+marker-changed\n+end\n*** End of File",
      ),
    ).toBe("start\nmarker\nend\nmiddle\nmarker-changed\nend\n")
  })

  it("preserves CRLF files", () => {
    expect(patchContent("crlf.txt", "old\r\n", "@@\n-old\n+new")).toBe("new\r\n")
  })
})

describe("ApplyPatch - Two-Phase Transactional ExecutionWorld Staging", () => {
  it.effect("applies multi-file atomic updates, additions, deletions, and moves in memory", () =>
    Effect.gen(function* () {
      const world = yield* ExecutionWorld
      const patch = [
        "*** Begin Patch",
        "*** Add File: src/newFile.ts",
        "+export const newFile = true",
        "*** Update File: src/existing.ts",
        "*** Move to: src/renamed.ts",
        "@@",
        "-const a = 1",
        "+const a = 100",
        "*** Delete File: src/obsolete.ts",
        "*** End Patch",
      ].join("\n")

      const result = yield* applyPatchTransaction(world, patch)
      assert.strictEqual(result.files.length, 3)
      assert.deepStrictEqual(result.files, ["src/newFile.ts", "src/renamed.ts", "src/obsolete.ts"])

      // Check filesystem results
      const newFileContent = yield* world.filesystem.readFileString("/workspace/src/newFile.ts")
      assert.strictEqual(newFileContent, "export const newFile = true\n")

      const renamedContent = yield* world.filesystem.readFileString("/workspace/src/renamed.ts")
      assert.strictEqual(renamedContent, "const a = 100\nconst b = 2\n")

      const oldExists = yield* world.filesystem.exists("/workspace/src/existing.ts")
      assert.strictEqual(oldExists, false)

      const obsoleteExists = yield* world.filesystem.exists("/workspace/src/obsolete.ts")
      assert.strictEqual(obsoleteExists, false)
    }).pipe(
      Effect.provide(
        ExecutionWorld.memory({
          root: "/workspace",
          files: {
            "/workspace/src/existing.ts": "const a = 1\nconst b = 2\n",
            "/workspace/src/obsolete.ts": "export const obsolete = true\n",
          },
        }).pipe(Layer.provide(NodePath.layer)),
      ),
    ),
  )

  it.effect("Phase 1 abort: aborts atomically without writing if any hunk in any file fails", () =>
    Effect.gen(function* () {
      const world = yield* ExecutionWorld
      const patch = [
        "*** Begin Patch",
        "*** Add File: src/shouldNotBeCreated.ts",
        "+export const temp = true",
        "*** Update File: src/fileA.ts",
        "@@",
        "-nonExistentContent",
        "+replacedContent",
        "*** End Patch",
      ].join("\n")

      const failure = yield* applyPatchTransaction(world, patch).pipe(Effect.flip)
      assert.strictEqual(failure._tag, "ToolFailure")
      assert.match(failure.message, /Failed to find expected lines in src\/fileA\.ts/)

      // Verify no changes were committed to the filesystem
      const addedExists = yield* world.filesystem.exists("/workspace/src/shouldNotBeCreated.ts")
      assert.strictEqual(addedExists, false)

      const fileAContent = yield* world.filesystem.readFileString("/workspace/src/fileA.ts")
      assert.strictEqual(fileAContent, "const original = 1\n")
    }).pipe(
      Effect.provide(
        ExecutionWorld.memory({
          root: "/workspace",
          files: {
            "/workspace/src/fileA.ts": "const original = 1\n",
          },
        }).pipe(Layer.provide(NodePath.layer)),
      ),
    ),
  )

  it.effect("Phase 1 path safety: prevents path traversal escaping workspace root", () =>
    Effect.gen(function* () {
      const world = yield* ExecutionWorld
      const patch = [
        "*** Begin Patch",
        "*** Add File: ../outside.txt",
        "+malicious content",
        "*** End Patch",
      ].join("\n")

      const failure = yield* applyPatchTransaction(world, patch).pipe(Effect.flip)
      assert.strictEqual(failure._tag, "ToolFailure")
      assert.match(failure.message, /path escapes the workspace root/)
    }).pipe(
      Effect.provide(
        ExecutionWorld.memory({
          root: "/workspace",
          files: {},
        }).pipe(Layer.provide(NodePath.layer)),
      ),
    ),
  )

  it.effect("Phase 1 path safety: prevents symlink escape outside workspace root", () =>
    Effect.gen(function* () {
      const agent = yield* Agent
      const events = yield* Stream.runCollect(
        agent.prompt({ prompt: "patch escape", sessionId: "s-patch-symlink" }),
      ).pipe(Effect.map((chunk) => [...chunk]))

      const toolResults = events.filter(isToolResult)
      assert.strictEqual(toolResults.length, 1)
      assert.strictEqual(toolResults[0]!.isFailure, true)
      /* SAFETY: ToolResult.result carries the failure payload with a message string. */
      const result = toolResults[0]!.result as { readonly message: string }
      assert.match(result.message, /path escapes the workspace root/)
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.unwrap(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            const path = yield* Path.Path
            const root = yield* fs.makeTempDirectoryScoped({ prefix: "roop-patch-symlink-root-" })
            const outside = yield* fs.makeTempDirectoryScoped({
              prefix: "roop-patch-symlink-outside-",
            })
            yield* fs.writeFileString(path.join(outside, "secret.txt"), "secret data\n")
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
                            id: "p1",
                            name: "applyPatch",
                            params: {
                              patch: [
                                "*** Begin Patch",
                                "*** Update File: link/secret.txt",
                                "@@",
                                "-secret data",
                                "+overwritten",
                                "*** End Patch",
                              ].join("\n"),
                            },
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

  it.effect("CodingTools.applyPatch runs via agent and tool loop", () =>
    Effect.gen(function* () {
      const agent = yield* Agent
      const events = yield* Stream.runCollect(
        agent.prompt({ prompt: "apply multi-file patch", sessionId: "s-patch-agent" }),
      ).pipe(Effect.map((chunk) => [...chunk]))

      const toolResults = events.filter(isToolResult)
      assert.strictEqual(toolResults.length, 1)
      assert.strictEqual(toolResults[0]!.isFailure, false)
      /* SAFETY: ToolResult.result carries the success payload with a files array. */
      const result = toolResults[0]!.result as { readonly files: ReadonlyArray<string> }
      assert.deepStrictEqual(result.files, ["src/created.ts", "src/modified.ts"])
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
                        id: "p1",
                        name: "applyPatch",
                        params: {
                          patch: [
                            "*** Begin Patch",
                            "*** Add File: src/created.ts",
                            "+export const created = 1",
                            "*** Update File: src/modified.ts",
                            "@@",
                            "-export const before = true",
                            "+export const before = false",
                            "*** End Patch",
                          ].join("\n"),
                        },
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
                "/workspace/src/modified.ts": "export const before = true\n",
              },
            }),
          ),
          Layer.provide(NodePath.layer),
        ),
      ),
    ),
  )

  it.effect("CodingTools.edit correctly handles replacement text with $ macros", () =>
    Effect.gen(function* () {
      const agent = yield* Agent
      const world = yield* ExecutionWorld
      const events = yield* Stream.runCollect(
        agent.prompt({ prompt: "edit dollar macro", sessionId: "s-edit-dollar" }),
      ).pipe(Effect.map((chunk) => [...chunk]))

      const toolResults = events.filter(isToolResult)
      assert.strictEqual(toolResults.length, 1)
      assert.strictEqual(toolResults[0]!.isFailure, false)

      const file = yield* world.resolvePath("src/script.sh")
      const content = yield* world.filesystem.readFileString(file)
      assert.strictEqual(content, 'echo "$VAR" && regex.replace(/foo/, "$&")\n')
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
                        id: "call-edit-1",
                        name: "edit",
                        params: {
                          path: "src/script.sh",
                          oldText: "echo OLD",
                          newText: 'echo "$VAR" && regex.replace(/foo/, "$&")',
                        },
                      },
                    ],
                    [{ type: "text-delta", id: "t1", delta: "edited" }],
                  ]),
                ),
              },
            ],
          }),
        ]).pipe(
          Layer.provideMerge(
            ExecutionWorld.memory({
              root: "/workspace",
              files: {
                "/workspace/src/script.sh": "echo OLD\n",
              },
            }),
          ),
          Layer.provide(SessionJournalMemory),
          Layer.provide(cryptoWeb),
          Layer.provide(NodePath.layer),
        ),
      ),
    ),
  )

  it.effect("CodingTools.find correctly matches wildcard globs across subdirectories", () =>
    Effect.gen(function* () {
      const agent = yield* Agent
      const events = yield* Stream.runCollect(
        agent.prompt({ prompt: "find index files", sessionId: "s-find-glob" }),
      ).pipe(Effect.map((chunk) => [...chunk]))

      const toolResults = events.filter(isToolResult)
      assert.strictEqual(toolResults.length, 1)
      assert.strictEqual(toolResults[0]!.isFailure, false)
      /* SAFETY: ToolResult.result contains the files array from find. */
      const result = toolResults[0]!.result as { readonly files: ReadonlyArray<string> }
      assert.deepStrictEqual(result.files, ["src/index.ts", "packages/core/src/index.ts"])
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
                        id: "call-find-1",
                        name: "find",
                        params: {
                          pattern: "index.*",
                        },
                      },
                    ],
                    [{ type: "text-delta", id: "t1", delta: "found" }],
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
                "/workspace/src/index.ts": "export const a = 1\n",
                "/workspace/packages/core/src/index.ts": "export const b = 2\n",
                "/workspace/src/other.ts": "export const c = 3\n",
              },
            }),
          ),
          Layer.provide(NodePath.layer),
        ),
      ),
    ),
  )
})
