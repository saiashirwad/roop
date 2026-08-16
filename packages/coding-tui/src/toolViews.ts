import {
  failureMessage,
  summarizeTool,
  WriteTodosParams,
  type ToolCall,
} from "@roop/agent-rpc/Transcript.ts"
import { Option, Schema } from "effect"

import { bold, cyan, dim, green, red } from "./theme.ts"

export interface ToolCallData {
  readonly name: string
  readonly params: unknown
  readonly result?: unknown
  readonly isFailure?: boolean
}

const line = (text: string, max = 120) => {
  const flat = text.replaceAll("\n", " ")
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

const todoIcon = {
  pending: dim("\uf10c"),
  active: cyan("\uf192"),
  done: green("\uf00c"),
} as const

const todoView = (call: ToolCall): string => {
  const todos =
    Option.getOrUndefined(Schema.decodeUnknownOption(WriteTodosParams)(call.params))?.todos ?? []
  const items = todos.map(
    (todo) => `  ${todoIcon[todo.state]} ${todo.state === "done" ? dim(todo.text) : todo.text}`,
  )
  return [`${cyan("\uf0ae")} ${bold("todos")}`, ...items].join("\n")
}

const iconOf = {
  readFile: `${cyan("\uf15b")} ${bold("read")}`,
  writeFile: `${cyan("\uf040")} ${bold("write")}`,
  edit: `${cyan("\uf044")} ${bold("edit")}`,
  listFiles: `${cyan("\uf115")} ${bold("list")}`,
  find: `${cyan("\uf0b0")} ${bold("find")}`,
  grep: `${cyan("\uf002")} ${bold("grep")}`,
  bash: `${cyan("\uf120")} ${bold("$")}`,
  webFetch: `${cyan("\uf0ac")} ${bold("fetch")}`,
  skill: `${cyan("\uf0c3")} ${bold("skill")}`,
  Subagent: `${cyan("\uf126")} ${bold("Subagent")}`,
  task: `${cyan("\uf126")} ${bold("Subagent")}`,
} as const

const iconFor = (name: string): string => {
  /* SAFETY: unknown names use the fallback after this typed lookup. */
  const key = name as keyof typeof iconOf
  return iconOf[key] ?? `${cyan("\uf013")} ${bold(name)}`
}

export const renderToolCall = (data: ToolCallData): string => {
  const failed = data.isFailure === true
  const call: ToolCall = {
    name: data.name,
    params: data.params,
    result: failed ? undefined : data.result,
  }
  const { summary } = summarizeTool(call)
  const body =
    data.name === "writeTodos"
      ? todoView(data)
      : `${iconFor(data.name)}${summary === "" ? "" : dim(` ${summary}`)}`
  // `undefined` is a valid Schema.Void result. The RPC worker marks every
  // completed call (including Void) with isFailure, so only an unset marker is pending.
  const pending = data.result === undefined && data.isFailure === undefined
  const status = failed ? red("\uf00d") : pending ? dim("\uf10c") : green("\uf00c")
  const message = failureMessage(data)
  const failure = failed && message !== undefined ? `\n  ${red(line(message))}` : ""
  return `${status} ${body}${failure}`
}
