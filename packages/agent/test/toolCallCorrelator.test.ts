import { assert, describe, it } from "@effect/vitest"
import { Option } from "effect"

import { makeToolCallCorrelator } from "../src/internal/toolCallCorrelator.ts"

describe("toolCallCorrelator", () => {
  it("uses one local token across provider call, result, and handler", () => {
    const correlator = makeToolCallCorrelator({ sessionId: "sess-1", turn: 1, step: 1 })
    const token = correlator.observeProviderCall({
      id: "provider-1",
      name: "worker",
      isKnownTool: true,
    })
    assert.ok(Option.isSome(token))
    if (Option.isSome(token)) {
      assert.strictEqual(correlator.allocateToken("worker"), token.value)
      assert.deepStrictEqual(correlator.tokenForProviderId("provider-1"), token)
    }
  })

  it("matches handler-first and provider-first calls by tool name", () => {
    const correlator = makeToolCallCorrelator({ sessionId: "sess-1", turn: 1, step: 1 })
    const first = correlator.allocateToken("read")
    const second = correlator.observeProviderCall({ id: "call-1", name: "read", isKnownTool: true })
    assert.deepStrictEqual(Option.some(first), second)
    const third = correlator.observeProviderCall({ id: "call-2", name: "read", isKnownTool: true })
    assert.ok(Option.isSome(third))
    if (Option.isSome(third)) {
      assert.strictEqual(correlator.allocateToken("read"), third.value)
    }
  })

  it("keeps distinct provider calls correlated when handlers finish out of order", () => {
    const correlator = makeToolCallCorrelator({ sessionId: "sess-1", turn: 1, step: 1 })
    const slow = correlator.observeProviderCall({
      id: "provider-slow",
      name: "slow",
      isKnownTool: true,
    })
    const fast = correlator.observeProviderCall({
      id: "provider-fast",
      name: "fast",
      isKnownTool: true,
    })

    assert.ok(Option.isSome(slow))
    assert.ok(Option.isSome(fast))
    if (Option.isSome(slow) && Option.isSome(fast)) {
      // Handler completion order is fast, then slow. Correlation uses the
      // provider call and tool name, not completion order.
      assert.strictEqual(correlator.allocateToken("fast"), fast.value)
      assert.strictEqual(correlator.allocateToken("slow"), slow.value)
      assert.deepStrictEqual(correlator.tokenForProviderId("provider-fast"), fast)
      assert.deepStrictEqual(correlator.tokenForProviderId("provider-slow"), slow)
    }
  })

  it("does not allocate local ids for provider-executed or unknown calls", () => {
    const correlator = makeToolCallCorrelator({ sessionId: "sess-1", turn: 1, step: 1 })
    assert.deepStrictEqual(
      correlator.observeProviderCall({
        id: "p",
        name: "web",
        providerExecuted: true,
        isKnownTool: true,
      }),
      Option.none(),
    )
    assert.deepStrictEqual(
      correlator.observeProviderCall({ id: "u", name: "missing", isKnownTool: false }),
      Option.none(),
    )
  })
})
