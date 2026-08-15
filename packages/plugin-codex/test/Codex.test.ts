import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { Agent } from "@roop/agent/Agent.ts"
import { cryptoWeb } from "@roop/agent/cryptoWeb.ts"
import { AgentPlugins } from "@roop/agent/Plugin.ts"
import { SessionStoreMemory } from "@roop/agent/SessionStore.ts"
import { Effect, Layer, Stream } from "effect"

import { Codex } from "../src/Codex.ts"

const live = process.env.CODEX_SMOKE !== undefined

it.layer(
  AgentPlugins([Codex()]).pipe(
    Layer.provide(SessionStoreMemory),
    Layer.provide(cryptoWeb),
    Layer.provide(NodeChildProcessSpawner.layer),
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(NodePath.layer),
  ),
)("Codex plugin", (it) => {
  it.effect("advertises the codex model", () =>
    Effect.gen(function* () {
      const caps = yield* (yield* Agent).capabilities()
      assert.deepStrictEqual(
        caps.models.map((model) => [model.id, model.provider]),
        [["gpt-5-codex", "codex"]],
      )
      assert.strictEqual(caps.defaultModelId, "gpt-5-codex")
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
