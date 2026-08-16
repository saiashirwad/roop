import { expect, it } from "vitest"

import { apply, summarizeTool } from "../src/Transcript.ts"

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
