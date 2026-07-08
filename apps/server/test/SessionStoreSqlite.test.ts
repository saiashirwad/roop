import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { assert, it } from "@effect/vitest"
import { SessionStore } from "@roop/core/SessionStore.ts"
import { sessionStoreScenarios } from "@roop/core/sessionStoreContract.ts"
import { Effect } from "effect"

import { SessionStoreSqliteLive } from "../src/SessionStoreSqlite.ts"

it.layer(SessionStoreSqliteLive(":memory:"))("SessionStore contract: sqlite", (it) => {
  for (const scenario of sessionStoreScenarios) {
    it.effect(scenario.name, () => scenario.run)
  }
})

it.effect("sqlite store persists across reopen", () => {
  const dbPath = join(mkdtempSync(join(tmpdir(), "roop-sessionstore-sqlite-")), "sessions.db")

  const write = Effect.gen(function* () {
    const store = yield* SessionStore
    const created = yield* store.create({ title: "durable" })
    yield* store.append(created.id, { _tag: "UserPrompt", prompt: "survive a restart" })
    return created
  }).pipe(Effect.provide(SessionStoreSqliteLive(dbPath)))

  return Effect.gen(function* () {
    const created = yield* write
    const session = yield* Effect.gen(function* () {
      const store = yield* SessionStore
      return yield* store.get(created.id)
    }).pipe(Effect.provide(SessionStoreSqliteLive(dbPath)))

    assert.strictEqual(session.records.length, 1)
    assert.strictEqual(session.records[0]?.entry._tag, "UserPrompt")
  })
})
