import { assert, describe, it } from "@effect/vitest"

import { makeToolCallCorrelator } from "../src/toolCallCorrelator.ts"

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
