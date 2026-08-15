import {
  failureMessage,
  isDelegation,
  resultSummary,
  summarizeTool,
  WriteTodosParams,
  type Item,
} from "@roop/agent-rpc/Transcript.ts"
import * as stylex from "@stylexjs/stylex"
import { Option, Schema } from "effect"
import { useState } from "react"

import { Markdown } from "./Markdown.tsx"

const styles = stylex.create({
  callout: {
    alignItems: "baseline",
    backgroundColor: "var(--callout)",
    borderRadius: 6,
    display: "flex",
    fontFamily: "var(--mono)",
    fontSize: 13,
    gap: 10,
    paddingBlock: 8,
    paddingInline: 14,
  },
  dot: {
    borderRadius: "50%",
    flexShrink: 0,
    height: 8,
    position: "relative",
    top: -1,
    width: 8,
  },
  running: { backgroundColor: "var(--amber)" },
  ok: { backgroundColor: "var(--green)" },
  failed: { backgroundColor: "var(--red)" },
  name: { color: "var(--text)", fontWeight: 600 },
  summary: {
    color: "var(--muted)",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  body: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
  failure: { color: "var(--red)" },
  todo: { color: "var(--text)", display: "flex", gap: 8 },
  todoDone: { color: "var(--faint)", textDecoration: "line-through" },
  todoMark: { flexShrink: 0, width: 14 },
  page: {
    borderColor: "var(--border)",
    borderRadius: 8,
    borderStyle: "solid",
    borderWidth: 1,
    overflow: "hidden",
  },
  pageHeader: {
    alignItems: "center",
    backgroundColor: { default: "transparent", ":hover": "var(--hover)" },
    borderWidth: 0,
    cursor: "pointer",
    display: "flex",
    fontFamily: "inherit",
    fontSize: 14,
    gap: 8,
    paddingBlock: 8,
    paddingInline: 12,
    textAlign: "left",
    width: "100%",
  },
  chevron: {
    color: "var(--faint)",
    display: "inline-block",
    flexShrink: 0,
    fontSize: 10,
    transitionDuration: "150ms",
    transitionProperty: "transform",
    width: 12,
  },
  chevronOpen: { transform: "rotate(90deg)" },
  pageIcon: { flexShrink: 0 },
  pageTitle: {
    fontWeight: 500,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  pageDot: { flexShrink: 0, marginLeft: "auto" },
  caption: {
    color: "var(--faint)",
    fontSize: 13,
    minWidth: 0,
    overflow: "hidden",
    paddingBlock: 0,
    paddingInline: 40,
    paddingBottom: 8,
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  pageBody: {
    borderLeftColor: "var(--border)",
    borderLeftStyle: "solid",
    borderLeftWidth: 2,
    display: "flex",
    flexDirection: "column",
    fontSize: 14,
    gap: 10,
    marginBottom: 12,
    marginLeft: 17,
    marginRight: 12,
    paddingLeft: 16,
  },
  childText: { fontSize: 14 },
})

type Tool = Extract<Item, { kind: "tool" }>

const line = (text: string, max = 120) => {
  const flat = text.replaceAll("\n", " ")
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

const marks = { pending: "○", active: "◉", done: "✓" } as const

const Todos = ({ tool }: { readonly tool: Tool }) => {
  const todos =
    Option.getOrUndefined(Schema.decodeUnknownOption(WriteTodosParams)(tool.params))?.todos ?? []
  return (
    <div {...stylex.props(styles.body)}>
      <span {...stylex.props(styles.name)}>todos</span>
      {todos.map((todo, index) => (
        <span key={index} {...stylex.props(styles.todo, todo.state === "done" && styles.todoDone)}>
          <span {...stylex.props(styles.todoMark)}>{marks[todo.state]}</span>
          {todo.text}
        </span>
      ))}
    </div>
  )
}

const statusOf = (tool: Tool) =>
  tool.result === undefined ? styles.running : tool.isFailure === true ? styles.failed : styles.ok

const activity = (items: ReadonlyArray<Item>): string => {
  const last = items.at(-1)
  if (last === undefined) return "starting…"
  switch (last.kind) {
    case "tool": {
      if (last.children !== undefined) return activity(last.children)
      const { label, summary } = summarizeTool(last)
      return `${label} ${summary}`
    }
    case "assistant":
      return line(last.text.slice(-160), 90)
    default:
      return "working…"
  }
}

const SubagentCard = ({ tool }: { readonly tool: Tool }) => {
  const [manual, setManual] = useState<boolean | undefined>(undefined)
  const running = tool.result === undefined
  const open = manual ?? running
  const { summary: task } = summarizeTool(tool)
  const caption =
    tool.isFailure === true
      ? (failureMessage(tool) ?? "failed")
      : running
        ? activity(tool.children ?? [])
        : (resultSummary(tool) ?? "")
  return (
    <div {...stylex.props(styles.page)}>
      <button {...stylex.props(styles.pageHeader)} onClick={() => setManual(!open)}>
        <span {...stylex.props(styles.chevron, open && styles.chevronOpen)}>▶</span>
        <span {...stylex.props(styles.pageIcon)}>📄</span>
        <span {...stylex.props(styles.pageTitle)}>{line(task, 80)}</span>
        <span {...stylex.props(styles.dot, styles.pageDot, statusOf(tool))} />
      </button>
      {!open && caption !== "" && (
        <div {...stylex.props(styles.caption, tool.isFailure === true && styles.failure)}>
          {caption}
        </div>
      )}
      {open && (
        <div {...stylex.props(styles.pageBody)}>
          {(tool.children ?? []).map((item, index) => {
            switch (item.kind) {
              case "assistant":
                return (
                  <div key={index} {...stylex.props(styles.childText)}>
                    <Markdown text={item.text} />
                  </div>
                )
              case "tool":
                return <ToolCard key={index} tool={item} />
              default:
                return null
            }
          })}
          {running && (
            <div {...stylex.props(styles.caption)} style={{ padding: 0 }}>
              {activity(tool.children ?? [])}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export const ToolCard = ({ tool }: { readonly tool: Tool }) => {
  if (isDelegation(tool.name)) {
    return <SubagentCard tool={tool} />
  }
  const failed = tool.isFailure === true
  const { label, summary } = summarizeTool(tool)
  const shown = failed ? { label, summary: failureMessage(tool) ?? "failed" } : { label, summary }
  return (
    <div {...stylex.props(styles.callout)}>
      <span {...stylex.props(styles.dot, statusOf(tool))} />
      {tool.name === "writeTodos" ? (
        <Todos tool={tool} />
      ) : (
        <>
          <span {...stylex.props(styles.name)}>{shown.label}</span>
          <span {...stylex.props(styles.summary, failed && styles.failure)}>{shown.summary}</span>
        </>
      )}
    </div>
  )
}
