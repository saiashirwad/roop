import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { Prompt } from "effect/unstable/ai"

import { AgentHooks, layerNoop, type RunContext } from "../src/AgentHooks.ts"
import { layerToolPruning, prunePromptMessages } from "../src/ToolPruning.ts"

describe("ToolPruning", () => {
  const dummyContext: RunContext = {
    sessionId: "test-session",
    turn: 1,
    step: 1,
  }

  it("prunes large historical tool results while preserving recent ones intact", () => {
    const hugeOutput = "A".repeat(5000)
    const smallOutput = "Hello world"

    // Construct a multi-turn conversation with 3 tool results
    const prompt = Prompt.fromMessages([
      Prompt.makeMessage("system", { content: "System instructions" }),
      Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text: "Step 1" })] }),
      Prompt.makeMessage("tool", {
        content: [
          Prompt.makePart("tool-result", {
            id: "call_1",
            name: "readFile",
            isFailure: false,
            result: hugeOutput, // Historical & large -> SHOULD BE PRUNED
          }),
        ],
      }),
      Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text: "Step 2" })] }),
      Prompt.makeMessage("tool", {
        content: [
          Prompt.makePart("tool-result", {
            id: "call_2",
            name: "readFile",
            isFailure: false,
            result: hugeOutput, // Recent result #1 -> KEPT INTACT
          }),
          Prompt.makePart("tool-result", {
            id: "call_3",
            name: "grep",
            isFailure: false,
            result: smallOutput, // Recent result #2 -> KEPT INTACT
          }),
        ],
      }),
    ])

    const pruned = prunePromptMessages(prompt, {
      maxResultBytes: 1000,
      keepRecentResults: 2,
      preserveFailures: true,
    })

    const toolMessages = pruned.content.filter((m) => m.role === "tool")
    assert.strictEqual(toolMessages.length, 2)

    // Verify call_1 was pruned
    // SAFETY: the fixture creates this tool-result part at index zero.
    const firstToolResult = (toolMessages[0]?.content[0] as any)?.result
    assert.strictEqual(firstToolResult?._pruned, true)
    assert.strictEqual(firstToolResult?.callId, "call_1")
    assert.strictEqual(firstToolResult?.originalBytes, 5000)

    // Verify call_2 was preserved intact because it is within the 2 most recent results
    // SAFETY: the fixture creates this tool-result part at index zero.
    const secondToolResult = (toolMessages[1]?.content[0] as any)?.result
    assert.strictEqual(secondToolResult, hugeOutput)

    // Verify call_3 was preserved intact
    // SAFETY: the fixture creates this tool-result part at index one.
    const thirdToolResult = (toolMessages[1]?.content[1] as any)?.result
    assert.strictEqual(thirdToolResult, smallOutput)
  })

  it.effect("integrates seamlessly into AgentHooks.beforeRequest waterfall", () =>
    Effect.gen(function* () {
      const hooks = yield* AgentHooks

      const hugeOutput = "B".repeat(4000)
      const prompt = Prompt.fromMessages([
        Prompt.makeMessage("tool", {
          content: [
            Prompt.makePart("tool-result", {
              id: "call_old",
              name: "bash",
              isFailure: false,
              result: hugeOutput,
            }),
          ],
        }),
        Prompt.makeMessage("tool", {
          content: [
            Prompt.makePart("tool-result", {
              id: "call_new",
              name: "bash",
              isFailure: false,
              result: "recent",
            }),
          ],
        }),
      ])

      const rewritten = yield* hooks.beforeRequest(dummyContext, {
        prompt,
      })

      const rewrittenPrompt = Prompt.make(rewritten.prompt)
      // SAFETY: the fixture creates this tool-result part at index zero.
      const firstResult = (rewrittenPrompt.content[0]?.content[0] as any)?.result
      assert.strictEqual(firstResult?._pruned, true)

      // SAFETY: the fixture creates this tool-result part at index zero.
      const secondResult = (rewrittenPrompt.content[1]?.content[0] as any)?.result
      assert.strictEqual(secondResult, "recent")
    }).pipe(
      Effect.provide(
        layerToolPruning({
          maxResultBytes: 500,
          keepRecentResults: 1,
        }).pipe(Layer.provideMerge(layerNoop)),
      ),
    ),
  )

  it("preserves every tool-call/result ID pairing while stubbing historical failures by default", () => {
    const hugeOutput = "X".repeat(4_000)
    const prompt = Prompt.fromMessages([
      Prompt.makeMessage("assistant", {
        content: [
          Prompt.makePart("tool-call", {
            id: "old-call",
            name: "bash",
            params: { command: "build" },
            providerExecuted: false,
          }),
        ],
      }),
      Prompt.makeMessage("tool", {
        content: [
          Prompt.makePart("tool-result", {
            id: "old-call",
            name: "bash",
            isFailure: true,
            result: hugeOutput,
          }),
        ],
      }),
      Prompt.makeMessage("assistant", {
        content: [
          Prompt.makePart("tool-call", {
            id: "current-call",
            name: "readFile",
            params: { path: "src/main.ts" },
            providerExecuted: false,
          }),
        ],
      }),
      Prompt.makeMessage("tool", {
        content: [
          Prompt.makePart("tool-result", {
            id: "current-call",
            name: "readFile",
            isFailure: false,
            result: hugeOutput,
          }),
        ],
      }),
    ])

    const pruned = prunePromptMessages(prompt, {
      maxResultBytes: 100,
      keepRecentResults: 0,
      preserveFailures: false,
    })
    const toolCallIds = pruned.content.flatMap((message) =>
      message.role === "assistant"
        ? message.content.flatMap((part) => (part.type === "tool-call" ? [part.id] : []))
        : [],
    )
    const toolResultIds = pruned.content.flatMap((message) =>
      message.role === "tool"
        ? message.content.flatMap((part) => (part.type === "tool-result" ? [part.id] : []))
        : [],
    )

    assert.deepStrictEqual(toolResultIds, toolCallIds)
    // SAFETY: the fixture creates this historical tool-result part at index zero.
    const oldResult = (pruned.content[1]?.content[0] as any)?.result
    assert.strictEqual(oldResult._pruned, true)
    // SAFETY: the fixture creates this current tool-result part at index zero.
    const currentResult = (pruned.content[3]?.content[0] as any)?.result
    assert.strictEqual(currentResult, hugeOutput)
  })

  it("is idempotent when run on already pruned prompt messages", () => {
    const prompt = Prompt.fromMessages([
      Prompt.makeMessage("tool", {
        content: [
          Prompt.makePart("tool-result", {
            id: "call_old",
            name: "bash",
            isFailure: false,
            result: {
              _pruned: true,
              toolName: "bash",
              callId: "call_old",
              originalBytes: 100000,
              summary: "Output pruned (100000 bytes).",
              notice: "Pruned notice",
            },
          }),
        ],
      }),
      Prompt.makeMessage("tool", {
        content: [
          Prompt.makePart("tool-result", {
            id: "call_new",
            name: "bash",
            isFailure: false,
            result: "recent",
          }),
        ],
      }),
    ])

    const pruned = prunePromptMessages(prompt, {
      maxResultBytes: 10,
      keepRecentResults: 1,
      preserveFailures: false,
    })

    // SAFETY: the fixture creates this tool-result part at index zero.
    const firstResult = (pruned.content[0]?.content[0] as any)?.result
    assert.strictEqual(firstResult?.originalBytes, 100000)
  })
})
