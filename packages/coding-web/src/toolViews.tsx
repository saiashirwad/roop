import * as stylex from "@stylexjs/stylex"

import type { Item } from "./state.ts"

const styles = stylex.create({
  card: {
    alignItems: "baseline",
    backgroundColor: "var(--surface)",
    borderColor: "var(--border)",
    borderRadius: 10,
    borderStyle: "solid",
    borderWidth: 1,
    display: "flex",
    fontFamily: "var(--mono)",
    fontSize: 13,
    gap: 8,
    paddingBlock: 8,
    paddingInline: 12,
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
})

type Tool = Extract<Item, { kind: "tool" }>

const line = (text: string, max = 120) => {
  const flat = text.replaceAll("\n", " ")
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

const bytes = (count: number) => (count < 1024 ? `${count}b` : `${(count / 1024).toFixed(1)}kb`)

const summaries: Record<string, (tool: Tool) => [string, string]> = {
  readFile: ({ params, result }) => {
    const { path } = params as { path: string }
    const { content } = (result ?? {}) as { content?: string }
    return ["read", `${path}${content === undefined ? "" : ` · ${bytes(content.length)}`}`]
  },
  writeFile: ({ params }) => {
    const { path, content } = params as { path: string; content: string }
    return ["write", `${path} · ${bytes(content.length)}`]
  },
  listFiles: ({ params, result }) => {
    const { path } = params as { path?: string }
    const { files } = (result ?? {}) as { files?: ReadonlyArray<string> }
    return ["list", `${path ?? "."}${files === undefined ? "" : ` · ${files.length} files`}`]
  },
  bash: ({ params, result }) => {
    const { command } = params as { command: string }
    const { exitCode } = (result ?? {}) as { exitCode?: number }
    const exit = exitCode === undefined || exitCode === 0 ? "" : ` · exit ${exitCode}`
    return ["$", `${line(command)}${exit}`]
  },
  webFetch: ({ params, result }) => {
    const { url } = params as { url: string }
    const { status, body } = (result ?? {}) as { status?: number; body?: string }
    return [
      "fetch",
      `${line(url)}${status === undefined ? "" : ` · ${status} · ${bytes(body?.length ?? 0)}`}`,
    ]
  },
  skill: ({ params }) => ["skill", (params as { id: string }).id],
  task: ({ params }) => ["task", line((params as { task: string }).task)],
}

const fallback = (tool: Tool): [string, string] => [
  tool.name,
  Object.entries((tool.params ?? {}) as Record<string, unknown>)
    .map(
      ([key, value]) =>
        `${key}: ${line(typeof value === "string" ? value : JSON.stringify(value), 40)}`,
    )
    .join(" · "),
]

const marks = { pending: "○", active: "◉", done: "✓" } as const

const Todos = ({ tool }: { readonly tool: Tool }) => {
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

export const ToolCard = ({ tool }: { readonly tool: Tool }) => {
  const state =
    tool.result === undefined ? styles.running : tool.isFailure === true ? styles.failed : styles.ok
  const [label, summary] =
    tool.isFailure === true
      ? [
          (summaries[tool.name] ?? fallback)({ ...tool, result: undefined })[0],
          (tool.result as { message?: string }).message ?? "failed",
        ]
      : (summaries[tool.name] ?? fallback)(tool)
  return (
    <div {...stylex.props(styles.card)}>
      <span {...stylex.props(styles.dot, state)} />
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
