import { assert, describe, it } from "@effect/vitest"

import { makeToolCallCorrelator, type SubagentEvent } from "../src/toolCallCorrelator.ts"

describe("toolCallCorrelator", () => {
  it("resolves subagent events when handler starts before provider call", () => {
    const correlator = makeToolCallCorrelator({ sessionId: "sess-1", turn: 1, step: 1 })

    // Handler starts
    const token = correlator.allocateToken("read_file")

    // Subagent event staged
    const subEvent: SubagentEvent = {
      _tag: "Subagent",
      name: "reader",
      toolCallId: token,
      event: { _tag: "TextDelta", delta: "hello" },
    }
    correlator.stageSubagent(token, subEvent)

    // Provider part arrives
    correlator.observeProviderCall({
      id: "call_123",
      name: "read_file",
      isKnownTool: true,
    })

    const drained = correlator.drainSubagentEvents()
    assert.strictEqual(drained.length, 1)
    assert.deepStrictEqual(drained[0], {
      _tag: "Subagent",
      name: "reader",
      toolCallId: "call_123",
      event: { _tag: "TextDelta", delta: "hello" },
    })
  })

  it("resolves subagent events when provider call arrives before handler starts", () => {
    const correlator = makeToolCallCorrelator({ sessionId: "sess-1", turn: 1, step: 1 })

    // Provider part arrives first
    correlator.observeProviderCall({
      id: "call_456",
      name: "bash",
      isKnownTool: true,
    })

    // Handler starts
    const token = correlator.allocateToken("bash")

    // Subagent event staged
    const subEvent: SubagentEvent = {
      _tag: "Subagent",
      name: "terminal",
      toolCallId: token,
      event: { _tag: "TextDelta", delta: "running cmd" },
    }
    correlator.stageSubagent(token, subEvent)

    const drained = correlator.drainSubagentEvents()
    assert.strictEqual(drained.length, 1)
    assert.deepStrictEqual(drained[0], {
      _tag: "Subagent",
      name: "terminal",
      toolCallId: "call_456",
      event: { _tag: "TextDelta", delta: "running cmd" },
    })
  })

  it("correctly correlates concurrent distinct tools", () => {
    const correlator = makeToolCallCorrelator({ sessionId: "sess-1", turn: 1, step: 1 })

    // Handler for tool B starts first
    const tokenB = correlator.allocateToken("toolB")
    // Handler for tool A starts second
    const tokenA = correlator.allocateToken("toolA")

    // B completes first, before A's provider parent call is observed.
    correlator.stageSubagent(tokenB, {
      _tag: "Subagent",
      name: "agentB",
      toolCallId: tokenB,
      event: { _tag: "TextDelta", delta: "event B" },
    })
    correlator.stageSubagent(tokenA, {
      _tag: "Subagent",
      name: "agentA",
      toolCallId: tokenA,
      event: { _tag: "TextDelta", delta: "event A" },
    })

    // Provider calls arrive in order A, then B
    correlator.observeProviderCall({ id: "call_A", name: "toolA", isKnownTool: true })
    correlator.observeProviderCall({ id: "call_B", name: "toolB", isKnownTool: true })

    const drained = correlator.drainSubagentEvents()
    assert.strictEqual(drained.length, 2)
    assert.deepStrictEqual(drained[0], {
      _tag: "Subagent",
      name: "agentA",
      toolCallId: "call_A",
      event: { _tag: "TextDelta", delta: "event A" },
    })
    assert.deepStrictEqual(drained[1], {
      _tag: "Subagent",
      name: "agentB",
      toolCallId: "call_B",
      event: { _tag: "TextDelta", delta: "event B" },
    })
  })

  it("ignores providerExecuted and unknown tool calls", () => {
    const correlator = makeToolCallCorrelator({ sessionId: "sess-1", turn: 1, step: 1 })

    correlator.observeProviderCall({
      id: "call_provider",
      name: "web_search",
      providerExecuted: true,
      isKnownTool: true,
    })
    correlator.observeProviderCall({
      id: "call_unknown",
      name: "nonexistent",
      providerExecuted: false,
      isKnownTool: false,
    })

    // Allocate token for a known tool
    const token = correlator.allocateToken("web_search")
    correlator.stageSubagent(token, {
      _tag: "Subagent",
      name: "searcher",
      toolCallId: token,
      event: { _tag: "TextDelta", delta: "search" },
    })

    // Provide the real call for web_search
    correlator.observeProviderCall({
      id: "call_web_real",
      name: "web_search",
      providerExecuted: false,
      isKnownTool: true,
    })

    const drained = correlator.drainSubagentEvents()
    assert.strictEqual(drained.length, 1)
    assert.deepStrictEqual(drained[0], {
      _tag: "Subagent",
      name: "searcher",
      toolCallId: "call_web_real",
      event: { _tag: "TextDelta", delta: "search" },
    })
  })
})
