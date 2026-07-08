import { appendFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { Effect, Layer } from "effect"

import { SessionStore, SessionStoreJsonlLive, SessionStoreMemoryLive } from "../src/SessionStore.ts"
import { sessionStoreScenarios } from "../src/sessionStoreContract.ts"

const contract = (label: string, layer: Layer.Layer<SessionStore>) => {
  it.layer(layer)(`SessionStore contract: ${label}`, (it) => {
    for (const scenario of sessionStoreScenarios) {
      it.effect(scenario.name, () => scenario.run)
    }
  })
}

contract("memory", SessionStoreMemoryLive)

const jsonlDirectory = mkdtempSync(join(tmpdir(), "roop-sessionstore-jsonl-"))

const JsonlLayer = SessionStoreJsonlLive(jsonlDirectory).pipe(
  Layer.provide(NodeFileSystem.layer),
  Layer.provide(NodePath.layer),
)

contract("jsonl", JsonlLayer)

it.layer(JsonlLayer)("SessionStore jsonl", (it) => {
  it.effect("skips corrupt and legacy lines on read", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore
      const created = yield* store.create()
      yield* store.append(created.id, { _tag: "UserPrompt", prompt: "before" })
      appendFileSync(join(jsonlDirectory, `${created.id}.jsonl`), 'not json\n{"legacy":"shape"}\n')
      yield* store.append(created.id, { _tag: "UserPrompt", prompt: "after" })

      const session = yield* store.get(created.id)
      assert.strictEqual(session.records.length, 2)
      assert.strictEqual(session.records[0]?.entry._tag, "UserPrompt")
      assert.strictEqual(session.records[1]?.entry._tag, "UserPrompt")
    }),
  )
})
