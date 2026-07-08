import { assert, it } from "@effect/vitest"
import { Effect } from "effect"

import { requestConfigFor, ZAI_MODELS, KIMI_MODELS, DEEPSEEK_MODELS } from "../src/models.ts"

it.effect("requestConfigFor maps effort and thinking for zai/deepseek", () =>
  Effect.sync(() => {
    const glm = ZAI_MODELS.find((m) => m.id === "zai/glm-5.2")!
    const cfg = requestConfigFor(glm, { effort: "max", thinking: false })
    assert.strictEqual(cfg.parallel_tool_calls, true)
    assert.strictEqual(cfg.reasoning_effort, "max")
    assert.deepStrictEqual(cfg.thinking, { type: "disabled" })

    const invalid = requestConfigFor(glm, { effort: "nope" })
    assert.strictEqual(invalid.reasoning_effort, "high")

    const deepseek = DEEPSEEK_MODELS[0]!
    const dcfg = requestConfigFor(deepseek, { effort: "high", thinking: true })
    assert.strictEqual(dcfg.reasoning_effort, "high")
    assert.deepStrictEqual(dcfg.thinking, { type: "enabled" })
  }),
)

it.effect("kimi always thinks and has no effort", () =>
  Effect.sync(() => {
    const kimi = KIMI_MODELS[0]!
    const cfg = requestConfigFor(kimi, { effort: "max", thinking: false })
    assert.strictEqual(cfg.reasoning_effort, undefined)
    assert.deepStrictEqual(cfg.thinking, { type: "enabled" })
  }),
)
