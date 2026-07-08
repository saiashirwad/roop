import { assert, it } from "@effect/vitest"
import { Effect, Layer } from "effect"

import { SessionSearch, SessionSearchFromStoreLive } from "../src/SessionSearch.ts"
import { SessionStore, SessionStoreMemoryLive } from "../src/SessionStore.ts"

const SearchLive = SessionSearchFromStoreLive.pipe(Layer.provideMerge(SessionStoreMemoryLive))

it.layer(SearchLive)("SessionSearch", (it) => {
  it.effect("search matches title and id", () =>
    Effect.gen(function* () {
      const store = yield* SessionStore
      const search = yield* SessionSearch

      const a = yield* store.create()
      yield* store.append(a.id, { _tag: "UserPrompt", prompt: "fix the tests please" })

      const b = yield* store.create()
      yield* store.append(b.id, { _tag: "UserPrompt", prompt: "explain the agent loop" })

      const byTitle = yield* search.search("tests")
      assert.strictEqual(byTitle.length, 1)
      assert.strictEqual(byTitle[0]?.id, a.id)

      const byId = yield* search.search(b.id.slice(0, 8))
      assert.ok(byId.some((summary) => summary.id === b.id))

      const all = yield* search.search("")
      assert.strictEqual(all.length, 2)
    }),
  )
})
