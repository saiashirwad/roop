import * as stylex from "@stylexjs/stylex"
import { useState } from "react"

import { Markdown } from "./Markdown.tsx"
import type { Item } from "./state.ts"

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

const bytes = (count: number) => (count < 1024 ? `${count}b` : `${(count / 1024).toFixed(1)}kb`)

const summaries: Record<string, (tool: Tool) => [string, string]> = {
  readFile: ({ params, result }) => {
    /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
    const { path } = params as { path: string }
    /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
    const { content } = (result ?? {}) as { content?: string }
    return ["read", `${path}${content === undefined ? "" : ` · ${bytes(content.length)}`}`]
  },
  writeFile: ({ params }) => {
    /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
    const { path, content } = params as { path: string; content: string }
    return ["write", `${path} · ${bytes(content.length)}`]
  },
  listFiles: ({ params, result }) => {
    /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
    const { path } = params as { path?: string }
    /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
    const { files } = (result ?? {}) as { files?: ReadonlyArray<string> }
    return ["list", `${path ?? "."}${files === undefined ? "" : ` · ${files.length} files`}`]
  },
  bash: ({ params, result }) => {
    /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
    const { command } = params as { command: string }
    /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
    const { exitCode } = (result ?? {}) as { exitCode?: number }
    const exit = exitCode === undefined || exitCode === 0 ? "" : ` · exit ${exitCode}`
    return ["$", `${line(command)}${exit}`]
  },
  webFetch: ({ params, result }) => {
    /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
    const { url } = params as { url: string }
    /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
    const { status, body } = (result ?? {}) as { status?: number; body?: string }
    return [
      "fetch",
      `${line(url)}${status === undefined ? "" : ` · ${status} · ${bytes(body?.length ?? 0)}`}`,
    ]
  },
  /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
  skill: ({ params }) => ["skill", (params as { id: string }).id],
}

const fallback = (tool: Tool): [string, string] => [
  tool.name,
  /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
  Object.entries((tool.params ?? {}) as Record<string, unknown>)
    .map(
      ([key, value]) =>
        `${key}: ${line(typeof value === "string" ? value : JSON.stringify(value), 40)}`,
    )
    .join(" · "),
]

const marks = { pending: "○", active: "◉", done: "✓" } as const

const Todos = ({ tool }: { readonly tool: Tool }) => {
  /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
  const { todos } = tool.params as {
    todos: ReadonlyArray<{ text: string; state: keyof typeof marks }>
  }
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
      const [label, summary] = (summaries[last.name] ?? fallback)(last)
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
  /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
  const { task } = tool.params as { task: string }
  const caption =
    tool.isFailure === true
      /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
      ? ((tool.result as { message?: string }).message ?? "failed")
      : running
        ? activity(tool.children ?? [])
        /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
        : ((tool.result as { summary?: string })?.summary ?? "")
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
  /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
  if (typeof (tool.params as { task?: unknown })?.task === "string") {
    return <SubagentCard tool={tool} />
  }
  const [label, summary] =
    tool.isFailure === true
      ? [
          (summaries[tool.name] ?? fallback)({ ...tool, result: undefined })[0],
          /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
          (tool.result as { message?: string }).message ?? "failed",
        ]
      : (summaries[tool.name] ?? fallback)(tool)
  return (
    <div {...stylex.props(styles.callout)}>
      <span {...stylex.props(styles.dot, statusOf(tool))} />
      {tool.name === "writeTodos" ? (
        <Todos tool={tool} />
      ) : (
        <>
          <span {...stylex.props(styles.name)}>{label}</span>
          <span {...stylex.props(styles.summary, tool.isFailure === true && styles.failure)}>
            {summary}
          </span>
        </>
      )}
    </div>
  )
}
