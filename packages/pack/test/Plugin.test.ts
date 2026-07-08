import { assert, it } from "@effect/vitest"
import {
  collectPromptContributions,
  definePlugin,
  mergePromptContributions,
  pluginSummaries,
} from "@roop/core/Plugin.ts"
import { clampGitLogCount } from "@roop/tools/git.ts"
import { Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"

import {
  packAgentMeta,
  packPluginMeta,
  packPlugins,
  packSystemPrompt,
  PackToolkit,
} from "../src/pack.ts"

it.effect("merges prompt contributions in plugin order", () =>
  Effect.sync(() => {
    const merged = mergePromptContributions([
      { id: "a", content: "first" },
      { id: "b", content: "  second  " },
      { id: "c", content: "" },
      { id: "d", content: "third" },
    ])
    assert.strictEqual(merged, "first\n\nsecond\n\nthird")
  }),
)

it.effect("collects prompts across plugins", () =>
  Effect.sync(() => {
    const collected = collectPromptContributions([
      { prompt: [{ id: "1", content: "alpha" }] },
      {
        prompt: [
          { id: "2", content: "beta" },
          { id: "3", content: "gamma" },
        ],
      },
    ])
    assert.deepStrictEqual(
      collected.map((c) => c.id),
      ["1", "2", "3"],
    )
  }),
)

it.effect("coding pack merges core, git, and subagents", () =>
  Effect.sync(() => {
    assert.strictEqual(packPlugins.length, 3)

    const toolNames = Object.keys(PackToolkit.tools).sort()
    assert.deepStrictEqual(toolNames, [
      "applyPatch",
      "awaitAgents",
      "bash",
      "checkAgent",
      "editFile",
      "gitDiff",
      "gitLog",
      "gitStatus",
      "grep",
      "listFiles",
      "readFile",
      "sendToAgent",
      "spawnAgent",
      "stopAgent",
      "writeFile",
    ])

    assert.ok(packSystemPrompt.includes("coding assistant"))
    assert.ok(packSystemPrompt.includes("gitStatus"))
    assert.ok(packSystemPrompt.includes("spawnAgent"))
    assert.ok(packSystemPrompt.includes("awaitAgents"))
    assert.deepStrictEqual(
      packPluginMeta.map((plugin) => plugin.id),
      ["core", "git", "subagents"],
    )
    assert.ok(packPluginMeta[0]?.tools.some((tool) => tool.name === "readFile"))
    assert.ok(packPluginMeta[1]?.tools.some((tool) => tool.name === "gitStatus"))
    assert.ok(packPluginMeta[1]?.features?.includes("diff"))
    assert.ok(packPluginMeta[2]?.tools.some((tool) => tool.name === "spawnAgent"))
    assert.ok(packPluginMeta[2]?.tools.some((tool) => tool.name === "stopAgent"))
    assert.ok(packPluginMeta[2]?.features?.includes("orchestrate"))

    const meta = packAgentMeta()
    assert.strictEqual(meta.session.store, "jsonl")
    assert.ok(meta.systemPrompt.length > 0)
    assert.ok(meta.agents?.some((agent) => agent.id === "explore"))
  }),
)

it.effect("clampGitLogCount bounds maxCount", () =>
  Effect.sync(() => {
    assert.strictEqual(clampGitLogCount(undefined), 10)
    assert.strictEqual(clampGitLogCount(0), 1)
    assert.strictEqual(clampGitLogCount(-3), 1)
    assert.strictEqual(clampGitLogCount(3.7), 3)
    assert.strictEqual(clampGitLogCount(100), 50)
  }),
)

it.effect("definePlugin wires toolkit, handlers, and prompt", () =>
  Effect.sync(() => {
    const Ping = Tool.make("ping", {
      description: "ping",
      parameters: Schema.Struct({}),
      success: Schema.Struct({ ok: Schema.Boolean }),
    })
    const toolkit = Toolkit.make(Ping)
    const plugin = definePlugin({
      id: "ping",
      description: "test",
      toolkit,
      handlers: toolkit.toLayer({
        ping: () => Effect.succeed({ ok: true }),
      }),
      prompt: [{ id: "ping/system", content: "ping only" }],
    })
    assert.strictEqual(plugin.id, "ping")
    assert.strictEqual(mergePromptContributions(plugin.prompt), "ping only")
    assert.deepStrictEqual(pluginSummaries([plugin]), [
      {
        id: "ping",
        description: "test",
        tools: [{ name: "ping", description: "ping" }],
      },
    ])
    assert.ok("ping" in plugin.toolkit.tools)
  }),
)
