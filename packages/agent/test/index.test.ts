import { assert, it } from "@effect/vitest"
import { Effect } from "effect"

import * as RoopAgent from "../src/index.ts"

it.effect("index: re-exports all root namespaces", () =>
  Effect.gen(function* () {
    assert.strictEqual(typeof RoopAgent.Agent.Agent.make, "function")
    assert.strictEqual(typeof RoopAgent.Runtime.AgentRuntime.run, "function")
    assert.strictEqual(typeof RoopAgent.Journal.Journal, "function")
    assert.strictEqual(typeof RoopAgent.RunPolicy.RunPolicy, "object")
    assert.strictEqual(typeof RoopAgent.Error.FinalizationError, "function")
    assert.ok(!("Policy" in RoopAgent))
    assert.ok(!("RunError" in RoopAgent))
  }),
)
