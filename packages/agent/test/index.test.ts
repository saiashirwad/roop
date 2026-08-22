import { assert, it } from "@effect/vitest"
import { Effect } from "effect"

import * as RoopAgent from "../src/index.ts"

it.effect("index: re-exports all root namespaces", () =>
  Effect.gen(function* () {
    assert.strictEqual(typeof RoopAgent.Agent.Agent, "function")
    assert.strictEqual(typeof RoopAgent.Plugin.Plugin, "function")
    assert.strictEqual(typeof RoopAgent.SessionJournal.SessionJournal, "function")
    assert.strictEqual(typeof RoopAgent.RunPolicy.RunPolicy, "object")
  }),
)
