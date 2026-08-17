import { expect, it } from "vitest"

import { apply, fromSessionEvents, summarizeTool } from "../src/Transcript.ts"

it("correlates nested subagent events by parent tool-call id", () => {
  let items = apply([], {
    _tag: "ToolCall",
    id: "first",
    name: "Subagent",
    params: { task: "one" },
  })
  items = apply(items, {
    _tag: "ToolCall",
    id: "second",
    name: "Subagent",
    params: { task: "two" },
  })
  items = apply(items, {
    _tag: "ToolResult",
    id: "first",
    name: "Subagent",
    isFailure: false,
    result: { summary: "one" },
  })
  items = apply(items, {
    _tag: "Subagent",
    name: "Subagent",
    toolCallId: "second",
    event: { _tag: "TextDelta", delta: "nested" },
  })

  expect(items[0]).toMatchObject({ kind: "tool", id: "first", completed: true })
  expect(items[1]).toMatchObject({
    kind: "tool",
    id: "second",
    completed: false,
    children: [{ kind: "assistant", text: "nested" }],
  })
})

it("coalesces consecutive reasoning deltas into one reasoning item", () => {
  let items = apply([], { _tag: "ReasoningDelta", delta: "think " })
  items = apply(items, { _tag: "ReasoningDelta", delta: "twice" })

  expect(items).toEqual([{ kind: "reasoning", text: "think twice" }])
})

it("starts new reasoning and assistant items when they interleave", () => {
  let items = apply([], { _tag: "ReasoningDelta", delta: "before" })
  items = apply(items, { _tag: "TextDelta", delta: "answer" })
  items = apply(items, { _tag: "ReasoningDelta", delta: "after" })

  expect(items).toEqual([
    { kind: "reasoning", text: "before" },
    { kind: "assistant", text: "answer" },
    { kind: "reasoning", text: "after" },
  ])
})

it("replays persisted reasoning parts as reasoning items", () => {
  const items = fromSessionEvents([
    {
      _tag: "assistant/message",
      parts: [
        { type: "reasoning", text: "deliberate" },
        { type: "text", text: "reply" },
      ],
    },
  ])

  expect(items).toEqual([
    { kind: "reasoning", text: "deliberate" },
    { kind: "assistant", text: "reply" },
  ])
})

it("summarizes unregistered tool names with the generic fallback", () => {
  expect(summarizeTool({ name: "deployK8s", params: { cluster: "prod" } })).toEqual({
    label: "deployK8s",
    summary: "cluster: prod",
  })
})

it("layers caller formatters over the built-in summaries", () => {
  const summarize = summarizeTool.with({
    deployK8s: () => ({ label: "deploy", summary: "prod cluster" }),
    bash: () => ({ label: "sh", summary: "caller wins" }),
  })

  expect(summarize({ name: "deployK8s", params: { cluster: "prod" } })).toEqual({
    label: "deploy",
    summary: "prod cluster",
  })
  expect(summarize({ name: "bash", params: { command: "ls" } })).toEqual({
    label: "sh",
    summary: "caller wins",
  })
  expect(
    summarize({ name: "readFile", params: { path: "a.txt" }, result: { content: "hi" } }),
  ).toEqual({ label: "read", summary: "a.txt · 2b" })
  expect(summarize({ name: "otherTool", params: { x: 1 } })).toEqual({
    label: "otherTool",
    summary: "x: 1",
  })
})

it("summarizes UTF-8 byte sizes rather than JavaScript code-unit lengths", () => {
  expect(
    summarizeTool({
      name: "readFile",
      params: { path: "emoji.txt" },
      result: { content: "😀" },
    }),
  ).toEqual({ label: "read", summary: "emoji.txt · 4b" })
  expect(
    summarizeTool({
      name: "writeFile",
      params: { path: "emoji.txt", content: "😀" },
    }),
  ).toEqual({ label: "write", summary: "emoji.txt · 4b" })
})
