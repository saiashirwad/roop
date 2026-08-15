import { Option, Schema } from "effect"

import { bold, cyan, dim, green, red, yellow } from "./theme.ts"

export interface ToolCallData {
  readonly name: string
  readonly params: unknown
  readonly result?: unknown
  readonly isFailure?: boolean
}

export type ToolView = (data: ToolCallData) => string

const line = (text: string, max = 80) => {
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
  truncated: Schema.optionalKey(Schema.Boolean),
})
const TodoState = Schema.Literals(["pending", "active", "done"])
const WriteTodosParams = Schema.Struct({
  todos: Schema.Array(Schema.Struct({ text: Schema.String, state: TodoState })),
})
const TaskParams = Schema.Struct({ task: Schema.String })
const ResultMessage = Schema.Struct({ message: Schema.optionalKey(Schema.String) })
const FallbackParams = Schema.Record(Schema.String, Schema.Json)
const jsonString = Schema.fromJsonString(Schema.Json)

const todoIcon = {
  pending: dim("\uf10c"),
  active: cyan("\uf192"),
  done: green("\uf00c"),
} as const

const formatParam = (value: Schema.Json): string =>
  Schema.is(Schema.String)(value) ? line(value, 40) : line(Schema.encodeSync(jsonString)(value), 40)

const fallbackView: ToolView = ({ name, params }) => {
  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(FallbackParams)(params))
  const entries =
    decoded === undefined
      ? []
      : Object.entries(decoded).map(([key, value]) => `${key}: ${formatParam(value)}`)
  return `${cyan("\uf013")} ${bold(name)}${entries.length > 0 ? dim(` ${entries.join(" · ")}`) : ""}`
}

const toolViews = {
  readFile: ({ params, result }) => {
    const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(ReadFileParams)(params))
    if (decoded === undefined) return fallbackView({ name: "readFile", params, result })
    const content =
      result === undefined
        ? undefined
        : Option.getOrUndefined(Schema.decodeUnknownOption(ReadFileResult)(result))?.content
    const size = content === undefined ? "" : dim(` · ${bytes(content.length)}`)
    return `${cyan("\uf15b")} ${bold("read")} ${decoded.path}${size}`
  },
  writeFile: ({ params, result }) => {
    const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(WriteFileParams)(params))
    if (decoded === undefined) return fallbackView({ name: "writeFile", params, result })
    return `${cyan("\uf040")} ${bold("write")} ${decoded.path}${dim(` · ${bytes(decoded.content.length)}`)}`
  },
  listFiles: ({ params, result }) => {
    const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(ListFilesParams)(params))
    if (decoded === undefined) return fallbackView({ name: "listFiles", params, result })
    const files =
      result === undefined
        ? undefined
        : Option.getOrUndefined(Schema.decodeUnknownOption(ListFilesResult)(result))?.files
    const count = files === undefined ? "" : dim(` · ${files.length} files`)
    return `${cyan("\uf115")} ${bold("list")} ${decoded.path ?? "."}${count}`
  },
  bash: ({ params, result }) => {
    const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(BashParams)(params))
    if (decoded === undefined) return fallbackView({ name: "bash", params, result })
    const exitCode =
      result === undefined
        ? undefined
        : Option.getOrUndefined(Schema.decodeUnknownOption(BashResult)(result))?.exitCode
    const exit = exitCode === undefined ? "" : exitCode === 0 ? "" : yellow(` · exit ${exitCode}`)
    return `${cyan("\uf120")} ${bold("$")} ${line(decoded.command)}${exit}`
  },
  webFetch: ({ params, result }) => {
    const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(WebFetchParams)(params))
    if (decoded === undefined) return fallbackView({ name: "webFetch", params, result })
    const payload =
      result === undefined
        ? undefined
        : Option.getOrUndefined(Schema.decodeUnknownOption(WebFetchResult)(result))
    const summary =
      payload?.status === undefined
        ? ""
        : dim(
            ` · ${payload.status} · ${bytes(payload.body?.length ?? 0)}${payload.truncated === true ? " truncated" : ""}`,
          )
    return `${cyan("\uf0ac")} ${bold("fetch")} ${line(decoded.url)}${summary}`
  },
  writeTodos: ({ params, result }) => {
    const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(WriteTodosParams)(params))
    if (decoded === undefined) return fallbackView({ name: "writeTodos", params, result })
    const items = decoded.todos.map(
      (todo) => `  ${todoIcon[todo.state]} ${todo.state === "done" ? dim(todo.text) : todo.text}`,
    )
    return [`${cyan("\uf0ae")} ${bold("todos")}`, ...items].join("\n")
  },
  task: ({ params, result }) => {
    const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(TaskParams)(params))
    if (decoded === undefined) return fallbackView({ name: "task", params, result })
    return `${cyan("\uf126")} ${bold("task")} ${line(decoded.task)}`
  },
} satisfies { readonly [name: string]: ToolView }

const viewOf = (name: string): ToolView => {
  switch (name) {
    case "readFile":
    case "writeFile":
    case "listFiles":
    case "bash":
    case "webFetch":
    case "writeTodos":
    case "task":
      return toolViews[name]
    default:
      return fallbackView
  }
}

export const renderToolCall = (data: ToolCallData): string => {
  const failed = data.isFailure === true
  const body = viewOf(data.name)(failed ? { ...data, result: undefined, isFailure: false } : data)
  const status =
    data.result === undefined ? dim("\uf10c") : failed ? red("\uf00d") : green("\uf00c")
  const message = Option.getOrUndefined(
    Schema.decodeUnknownOption(ResultMessage)(data.result),
  )?.message
  const failure = failed && message !== undefined ? `\n  ${red(line(message, 120))}` : ""
  return `${status} ${body}${failure}`
}
