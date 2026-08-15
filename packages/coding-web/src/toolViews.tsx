import * as stylex from "@stylexjs/stylex"
import { Option, Schema } from "effect"
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

const ReadFileParams = Schema.Struct({ path: Schema.String })
const ReadFileResult = Schema.Struct({ content: Schema.optionalKey(Schema.String) })
const WriteFileParams = Schema.Struct({ path: Schema.String, content: Schema.String })
const ListFilesParams = Schema.Struct({ path: Schema.optionalKey(Schema.String) })
const ListFilesResult = Schema.Struct({ files: Schema.optionalKey(Schema.Array(Schema.String)) })
const BashParams = Schema.Struct({ command: Schema.String })
const BashResult = Schema.Struct({ exitCode: Schema.optionalKey(Schema.Finite) })
const WebFetchParams = Schema.Struct({ url: Schema.String })
const WebFetchResult = Schema.Struct({
  status: Schema.optionalKey(Schema.Finite),
  body: Schema.optionalKey(Schema.String),
})
const SkillParams = Schema.Struct({ id: Schema.String })
const TaskParams = Schema.Struct({ task: Schema.String })
const ResultMessage = Schema.Struct({ message: Schema.optionalKey(Schema.String) })
const ResultSummary = Schema.Struct({ summary: Schema.optionalKey(Schema.String) })
const TodoState = Schema.Literals(["pending", "active", "done"])
const WriteTodosParams = Schema.Struct({
  todos: Schema.Array(Schema.Struct({ text: Schema.String, state: TodoState })),
})
const FallbackParams = Schema.Record(Schema.String, Schema.Json)
const jsonString = Schema.fromJsonString(Schema.Json)

const formatParam = (value: Schema.Json): string =>
  Schema.is(Schema.String)(value) ? line(value, 40) : line(Schema.encodeSync(jsonString)(value), 40)

const fallback = (tool: Tool): [string, string] => {
  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(FallbackParams)(tool.params))
  const summary =
    decoded === undefined
      ? ""
      : Object.entries(decoded)
          .map(([key, value]) => `${key}: ${formatParam(value)}`)
          .join(" · ")
  return [tool.name, summary]
}

const summaries = {
  readFile: (tool: Tool): [string, string] => {
    const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(ReadFileParams)(tool.params))
    if (decoded === undefined) return fallback(tool)
    const content =
      tool.result === undefined
        ? undefined
        : Option.getOrUndefined(Schema.decodeUnknownOption(ReadFileResult)(tool.result))?.content
    return ["read", `${decoded.path}${content === undefined ? "" : ` · ${bytes(content.length)}`}`]
  },
  writeFile: (tool: Tool): [string, string] => {
    const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(WriteFileParams)(tool.params))
    if (decoded === undefined) return fallback(tool)
    return ["write", `${decoded.path} · ${bytes(decoded.content.length)}`]
  },
  listFiles: (tool: Tool): [string, string] => {
    const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(ListFilesParams)(tool.params))
    if (decoded === undefined) return fallback(tool)
    const files =
      tool.result === undefined
        ? undefined
        : Option.getOrUndefined(Schema.decodeUnknownOption(ListFilesResult)(tool.result))?.files
    return [
      "list",
      `${decoded.path ?? "."}${files === undefined ? "" : ` · ${files.length} files`}`,
    ]
  },
  bash: (tool: Tool): [string, string] => {
    const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(BashParams)(tool.params))
    if (decoded === undefined) return fallback(tool)
    const exitCode =
      tool.result === undefined
        ? undefined
        : Option.getOrUndefined(Schema.decodeUnknownOption(BashResult)(tool.result))?.exitCode
    const exit = exitCode === undefined || exitCode === 0 ? "" : ` · exit ${exitCode}`
    return ["$", `${line(decoded.command)}${exit}`]
  },
  webFetch: (tool: Tool): [string, string] => {
    const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(WebFetchParams)(tool.params))
    if (decoded === undefined) return fallback(tool)
    const payload =
      tool.result === undefined
        ? undefined
        : Option.getOrUndefined(Schema.decodeUnknownOption(WebFetchResult)(tool.result))
    return [
      "fetch",
      `${line(decoded.url)}${payload?.status === undefined ? "" : ` · ${payload.status} · ${bytes(payload.body?.length ?? 0)}`}`,
    ]
  },
  skill: (tool: Tool): [string, string] => {
    const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(SkillParams)(tool.params))
    if (decoded === undefined) return fallback(tool)
    return ["skill", decoded.id]
  },
}

const summarize = (tool: Tool): [string, string] => {
  switch (tool.name) {
    case "readFile":
    case "writeFile":
    case "listFiles":
    case "bash":
    case "webFetch":
    case "skill":
      return summaries[tool.name](tool)
    default:
      return fallback(tool)
  }
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
      const [label, summary] = summarize(last)
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
  const task =
    Option.getOrUndefined(Schema.decodeUnknownOption(TaskParams)(tool.params))?.task ?? ""
  const caption =
    tool.isFailure === true
      ? (Option.getOrUndefined(Schema.decodeUnknownOption(ResultMessage)(tool.result))?.message ??
        "failed")
      : running
        ? activity(tool.children ?? [])
        : (Option.getOrUndefined(Schema.decodeUnknownOption(ResultSummary)(tool.result))?.summary ??
          "")
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
  if (Schema.is(TaskParams)(tool.params)) {
    return <SubagentCard tool={tool} />
  }
  const [label, summary] =
    tool.isFailure === true
      ? [
          summarize({ ...tool, result: undefined })[0],
          Option.getOrUndefined(Schema.decodeUnknownOption(ResultMessage)(tool.result))?.message ??
            "failed",
        ]
      : summarize(tool)
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
