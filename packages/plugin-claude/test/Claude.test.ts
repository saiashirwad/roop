import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { Agent } from "@roop/agent/Agent.ts"
import { cryptoWeb } from "@roop/agent/cryptoWeb.ts"
import { AgentPlugins } from "@roop/agent/Plugin.ts"
import { SessionStoreMemory } from "@roop/agent/SessionStore.ts"
import { Effect, Layer, Stream } from "effect"

import { Claude } from "../src/Claude.ts"

const live = process.env.CLAUDE_SMOKE !== undefined

it.layer(
  AgentPlugins([Claude()]).pipe(
    Layer.provide(SessionStoreMemory),
    Layer.provide(cryptoWeb),
    Layer.provide(NodeChildProcessSpawner.layer),
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(NodePath.layer),
  ),
)("Claude plugin", (it) => {
  it.effect("advertises the claude model", () =>
    Effect.gen(function* () {
      const caps = yield* (yield* Agent).capabilities
      assert.deepStrictEqual(
        caps.models.map((model) => [model.id, model.provider]),
        [["sonnet", "claude"]],
      )
      assert.strictEqual(caps.defaultModelId, "sonnet")
    }),
  )

  it.effect.skipIf(!live)("streams a text reply", () =>
    Effect.gen(function* () {
      const agent = yield* Agent
      const events = yield* Stream.runCollect(
        agent.prompt({
          prompt: "Reply with exactly the word banana and nothing else.",
          sessionId: "live",
        }),
      )
      const deltas = [...events]
        .filter((event) => event._tag === "TextDelta")
        .map((event) => event.delta)
        .join("")
      assert.ok(deltas.toLowerCase().includes("banana"), `expected banana, got: ${deltas}`)
    }),
  )
})
