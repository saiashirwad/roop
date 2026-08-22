import { assert, describe, it } from "@effect/vitest"

import { makeToolCallCorrelator } from "../src/internal/toolCallCorrelator.ts"

describe("toolCallCorrelator", () => {
  it("uses one local token across provider call, result, and handler", () => {
    const correlator = makeToolCallCorrelator({ sessionId: "sess-1", turn: 1, step: 1 })
    const token = correlator.observeProviderCall({
      id: "provider-1",
      name: "worker",
      isKnownTool: true,
    })
    assert.ok(token !== undefined)
    assert.strictEqual(correlator.allocateToken("worker"), token)
    assert.strictEqual(correlator.tokenForProviderId("provider-1"), token)
  })

  it("matches handler-first and provider-first calls by tool name", () => {
    const correlator = makeToolCallCorrelator({ sessionId: "sess-1", turn: 1, step: 1 })
    const first = correlator.allocateToken("read")
    const second = correlator.observeProviderCall({ id: "call-1", name: "read", isKnownTool: true })
    assert.strictEqual(first, second)
    const third = correlator.observeProviderCall({ id: "call-2", name: "read", isKnownTool: true })
    assert.strictEqual(correlator.allocateToken("read"), third)
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

    assert.ok(slow !== undefined)
    assert.ok(fast !== undefined)
    // Handler completion order is fast, then slow. Correlation uses the
    // provider call and tool name, not completion order.
    assert.strictEqual(correlator.allocateToken("fast"), fast)
    assert.strictEqual(correlator.allocateToken("slow"), slow)
    assert.strictEqual(correlator.tokenForProviderId("provider-fast"), fast)
    assert.strictEqual(correlator.tokenForProviderId("provider-slow"), slow)
  })

  it("does not allocate local ids for provider-executed or unknown calls", () => {
    const correlator = makeToolCallCorrelator({ sessionId: "sess-1", turn: 1, step: 1 })
    assert.strictEqual(
      correlator.observeProviderCall({
        id: "p",
        name: "web",
        providerExecuted: true,
        isKnownTool: true,
      }),
      undefined,
    )
    assert.strictEqual(
      correlator.observeProviderCall({ id: "u", name: "missing", isKnownTool: false }),
      undefined,
    )
  })
})
