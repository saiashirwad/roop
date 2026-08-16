import { assert, it } from "@effect/vitest"
import { Effect } from "effect"

import * as RoopAgent from "../src/index.ts"

it.effect("index: re-exports all root namespaces", () =>
  Effect.gen(function* () {
    assert.strictEqual(typeof RoopAgent.Agent.Agent, "function")
    assert.strictEqual(typeof RoopAgent.AgentContext.AgentContext, "function")
    assert.strictEqual(typeof RoopAgent.Plugin.Plugin, "function")
    assert.strictEqual(typeof RoopAgent.SessionJournal.SessionJournal, "function")
    assert.strictEqual(typeof RoopAgent.SessionId.SessionId, "object")
    assert.strictEqual(typeof RoopAgent.RunId.RunId, "object")
    assert.strictEqual(typeof RoopAgent.EventId.EventId, "object")
    assert.strictEqual(typeof RoopAgent.ModelId.ModelId, "object")
    assert.strictEqual(typeof RoopAgent.PluginId.PluginId, "object")
    assert.strictEqual(typeof RoopAgent.ToolCallId.ToolCallId, "object")
    assert.strictEqual(typeof RoopAgent.RunPolicy.RunPolicy, "object")
    assert.strictEqual(typeof RoopAgent.RunRegistry.RunRegistry, "function")
  }),
)
