import { assert, it } from "@effect/vitest"
import { Effect } from "effect"

import {
  capabilitiesFromMeta,
  deriveFeatures,
  type AgentCapabilities,
  type AgentMeta,
} from "../src/AgentCapabilities.ts"
import { hasFeature, hasPlugin, hasTool, pluginForTool } from "../src/capabilityQueries.ts"

const sample: AgentCapabilities = {
  models: [
    {
      id: "kimi/k2p7",
      name: "K2.7 Code",
      provider: "kimi",
      settings: { thinking: { canDisable: false, default: true } },
    },
  ],
  defaultModelId: "kimi/k2p7",
  sessionStore: "jsonl",
  sessionHub: "in-process",
  sessionSearch: "from-store",
  features: ["sessions", "interrupt", "plugins", "models"],
  tools: [
    { name: "readFile", description: "read" },
    { name: "gitStatus", description: "status" },
  ],
  agents: [],
  plugins: [
    {
      id: "core",
      description: "core tools",
      tools: [{ name: "readFile", description: "read" }],
    },
    {
      id: "git",
      description: "git tools",
      tools: [{ name: "gitStatus", description: "status" }],
    },
  ],
}

it.effect("capability helpers gate on plugins and tools", () =>
  Effect.sync(() => {
    assert.strictEqual(hasPlugin(sample, "git"), true)
    assert.strictEqual(hasPlugin(sample, "typescript"), false)
    assert.strictEqual(hasPlugin(undefined, "git"), false)

    assert.strictEqual(hasTool(sample, "gitStatus"), true)
    assert.strictEqual(hasTool(sample, "missing"), false)

    assert.strictEqual(hasFeature(sample, "interrupt"), true)
    assert.strictEqual(hasFeature(undefined, "interrupt"), false)

    assert.strictEqual(pluginForTool(sample, "gitStatus")?.id, "git")
    assert.strictEqual(pluginForTool(sample, "readFile")?.id, "core")
    assert.strictEqual(pluginForTool(sample, "nope"), undefined)
  }),
)

it.effect("deriveFeatures reflects wired session backends", () =>
  Effect.sync(() => {
    const full = deriveFeatures({
      tools: [{ name: "x", description: "" }],
      plugins: [{ id: "p", description: "", tools: [] }],
      session: { store: "jsonl", hub: "in-process", search: "from-store" },
      models: [
        {
          id: "kimi/k2p7",
          name: "K2.7 Code",
          provider: "kimi",
          settings: {},
        },
      ],
    })
    assert.deepStrictEqual(full, [
      "sessions",
      "interrupt",
      "tools",
      "plugins",
      "search",
      "subscribe",
      "models",
    ])

    const minimal = deriveFeatures({
      tools: [],
      plugins: [],
      session: { store: "memory", hub: "none", search: "none" },
    })
    assert.deepStrictEqual(minimal, ["sessions", "interrupt"])
  }),
)

it.effect("capabilitiesFromMeta fills store/hub/search and models", () =>
  Effect.sync(() => {
    const meta: AgentMeta = {
      systemPrompt: "hi",
      plugins: [],
      session: { store: "jsonl", hub: "in-process", search: "from-store" },
    }
    const models = [
      {
        id: "kimi/k2p7",
        name: "K2.7 Code",
        provider: "kimi",
        settings: {
          effort: { levels: ["high", "max"], default: "high" },
        },
      },
    ]
    const caps = capabilitiesFromMeta(meta, [], models, "kimi/k2p7")
    assert.strictEqual(caps.sessionStore, "jsonl")
    assert.strictEqual(caps.sessionHub, "in-process")
    assert.strictEqual(caps.sessionSearch, "from-store")
    assert.strictEqual(caps.defaultModelId, "kimi/k2p7")
    assert.strictEqual(caps.models.length, 1)
    assert.ok(caps.features.includes("subscribe"))
    assert.ok(caps.features.includes("search"))
    assert.ok(caps.features.includes("models"))
    assert.ok(!caps.features.includes("tools"))
  }),
)
