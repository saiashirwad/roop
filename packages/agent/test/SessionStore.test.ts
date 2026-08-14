import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { NodeFileSystem } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { Prompt } from "effect/unstable/ai"

import { SessionStore, SessionStoreFs } from "../src/SessionStore.ts"

const dir = mkdtempSync(join(tmpdir(), "sessions-"))
const StoreLive = SessionStoreFs(dir).pipe(Layer.provide(NodeFileSystem.layer))

const user = (text: string) => Prompt.userMessage({ content: [Prompt.makePart("text", { text })] })

it.layer(StoreLive)("SessionStoreFs", (it) => {
  it.effect("persists sessions and lists them by recency", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore
      yield* store.save("a", [user("first question")])
      yield* store.save("b", [user("second question")])

      const loaded = yield* store.load("a")
      assert.strictEqual(loaded.messages.length, 1)

      const metas = yield* store.list()
      assert.deepStrictEqual(
        metas.map((meta) => [meta.id, meta.title]),
        [
          ["b", "second question"],
          ["a", "first question"],
        ],
      )

      const reopened = yield* Effect.provide(
        Effect.gen(function* () {
          return yield* (yield* SessionStore).list()
        }),
        SessionStoreFs(dir).pipe(Layer.provide(NodeFileSystem.layer)),
      )
      assert.strictEqual(reopened.length, 2)
    }),
  )
})
