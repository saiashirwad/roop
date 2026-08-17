import type { AgentEvent } from "@roop/agent/AgentEvent.ts"
import { deriveMessages, type SessionEvent } from "@roop/agent/SessionEvent.ts"
import { Option, Schema } from "effect"

/**
 * UI-agnostic transcript projection: the `Item` tree both clients render, the
 * event projection that builds it, and per-tool summaries. Clients keep only
 * their renderers (ANSI for the TUI, stylex for the web).
 */

export type Item =
  | { readonly kind: "user"; readonly text: string }
  | { readonly kind: "assistant"; readonly text: string }
  | {
      readonly kind: "tool"
      readonly id: string
      readonly name: string
      readonly params: unknown
      readonly completed: boolean
      readonly result?: unknown
      readonly isFailure?: boolean
      readonly children?: ReadonlyArray<Item>
    }
  | { readonly kind: "notice"; readonly text: string }

/** Fold one agent event into the transcript. */
export const apply = (items: ReadonlyArray<Item>, event: AgentEvent): ReadonlyArray<Item> => {
  switch (event._tag) {
    case "TextDelta": {
      const last = items.at(-1)
      return last?.kind === "assistant"
        ? [...items.slice(0, -1), { kind: "assistant", text: last.text + event.delta }]
        : [...items, { kind: "assistant", text: event.delta }]
    }
    case "ReasoningDelta": {
      return items
    }
    case "ToolCall": {
      return [
        ...items,
        { kind: "tool", id: event.id, name: event.name, params: event.params, completed: false },
      ]
    }
    case "ToolResult": {
      return items.map((item) =>
        item.kind === "tool" && item.id === event.id
          ? { ...item, result: event.result, completed: true, isFailure: event.isFailure }
          : item,
      )
    }
    case "Finish": {
      return event.reason === "completed"
        ? items
        : [
            ...items,
            {
              kind: "notice",
              text: `${event.reason}${event.message === undefined ? "" : `: ${event.message}`}`,
            },
          ]
    }
    case "Subagent": {
      // New events carry the stable parent tool-call id. Keep the name-based
      // fallback only for old clients/logs that predate that field.
      const index =
        event.toolCallId === undefined
          ? items.findLastIndex(
              (item) => item.kind === "tool" && item.name === event.name && !item.completed,
            )
          : items.findLastIndex((item) => item.kind === "tool" && item.id === event.toolCallId)
      if (index === -1) return items
      /* SAFETY: The predicate above guarantees this item is a tool call. */
      const target = items[index] as Extract<Item, { kind: "tool" }>
      const next = [...items]
      next[index] = { ...target, children: apply(target.children ?? [], event.event) }
      return next
    }
  }
}

/** Rebuild a transcript from persisted session events. */
export const fromSessionEvents = (events: ReadonlyArray<SessionEvent>): ReadonlyArray<Item> =>
  fromMessages(deriveMessages(events))

/** Rebuild a transcript from a persisted session's derived messages. */
export const fromMessages = (messages: ReturnType<typeof deriveMessages>): ReadonlyArray<Item> => {
  let items: Array<Item> = []
  for (const message of messages) {
    switch (message.role) {
      case "system":
        break
      case "user": {
        for (const part of message.content) {
          if (part.type === "text") {
            items = [...items, { kind: "user", text: part.text }]
          }
        }
        break
      }
      case "assistant": {
        for (const part of message.content) {
          if (part.type === "text") {
            items = [...items, { kind: "assistant", text: part.text }]
          } else if (part.type === "tool-call") {
            items = [
              ...items,
              { kind: "tool", id: part.id, name: part.name, params: part.params, completed: false },
            ]
          }
        }
        break
      }
      case "tool": {
        for (const part of message.content) {
          if (part.type === "tool-result") {
            items = items.map((item) =>
              item.kind === "tool" && item.id === part.id
                ? { ...item, result: part.result, completed: true, isFailure: part.isFailure }
                : item,
            )
          }
        }
        break
      }
    }
  }
  return items
}

/** The delegation tool the coding harness exposes; subagent calls render as nested pages. */
export const delegationToolName = "Subagent"

export const isDelegation = (name: string): boolean => name === delegationToolName

export type ToolSummary = {
  readonly label: string
  readonly summary: string
}

/** A tool call at the client boundary: raw name/params/result as they arrived. */
export type ToolCall = {
  readonly name: string
  readonly params: unknown
  readonly result?: unknown
}

/** A tool result envelope, for readers that only care about the outcome. */
export type ToolOutcome = {
  readonly result?: unknown
}

const line = (text: string, max = 80) => {
  const flat = text.replaceAll("\n", " ")
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).byteLength
const bytes = (count: number) => (count < 1024 ? `${count}b` : `${(count / 1024).toFixed(1)}kb`)

const ReadFileParams = Schema.Struct({ path: Schema.String })
const ReadFileResult = Schema.Struct({ content: Schema.optionalKey(Schema.String) })
const WriteFileParams = Schema.Struct({ path: Schema.String, content: Schema.String })
const EditParams = Schema.Struct({
  path: Schema.String,
  edits: Schema.optionalKey(
    Schema.Array(Schema.Struct({ oldText: Schema.String, newText: Schema.String })),
  ),
  oldText: Schema.optionalKey(Schema.String),
  newText: Schema.optionalKey(Schema.String),
})
const EditResult = Schema.Struct({
  path: Schema.optionalKey(Schema.String),
  appliedEdits: Schema.optionalKey(Schema.Finite),
})
const ListFilesParams = Schema.Struct({ path: Schema.optionalKey(Schema.String) })
const ListFilesResult = Schema.Struct({ files: Schema.optionalKey(Schema.Array(Schema.String)) })
const FindParams = Schema.Struct({
  pattern: Schema.optionalKey(Schema.String),
  path: Schema.optionalKey(Schema.String),
})
const FindResult = Schema.Struct({
  files: Schema.optionalKey(Schema.Array(Schema.String)),
  totalFiles: Schema.optionalKey(Schema.Finite),
})
const GrepParams = Schema.Struct({
  pattern: Schema.String,
  path: Schema.optionalKey(Schema.String),
})
const GrepResult = Schema.Struct({
  matches: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ file: Schema.String, line: Schema.Finite, content: Schema.String }),
    ),
  ),
  totalMatches: Schema.optionalKey(Schema.Finite),
})
const BashParams = Schema.Struct({ command: Schema.String })
const BashResult = Schema.Struct({ exitCode: Schema.optionalKey(Schema.Finite) })
const WebFetchParams = Schema.Struct({ url: Schema.String })
const WebFetchResult = Schema.Struct({
  status: Schema.optionalKey(Schema.Finite),
  body: Schema.optionalKey(Schema.String),
  truncated: Schema.optionalKey(Schema.Boolean),
})
const SkillParams = Schema.Struct({ id: Schema.String })
const TaskParams = Schema.Struct({ task: Schema.String })
const FallbackParams = Schema.Record(Schema.String, Schema.Json)
const jsonString = Schema.fromJsonString(Schema.Json)

export const TodoState = Schema.Literals(["pending", "active", "done"])
export const WriteTodosParams = Schema.Struct({
  todos: Schema.Array(Schema.Struct({ text: Schema.String, state: TodoState })),
})

const formatParam = (value: Schema.Json): string =>
  Schema.is(Schema.String)(value) ? line(value, 40) : line(Schema.encodeSync(jsonString)(value), 40)

const fallback = (call: ToolCall): ToolSummary => {
  const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(FallbackParams)(call.params))
  const summary =
    decoded === undefined
      ? ""
      : Object.entries(decoded)
          .map(([key, value]) => `${key}: ${formatParam(value)}`)
          .join(" · ")
  return { label: call.name, summary }
}

const summaryOf = {
  readFile: (call: ToolCall): ToolSummary => {
    const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(ReadFileParams)(call.params))
    if (decoded === undefined) return fallback(call)
    const content =
      call.result === undefined
        ? undefined
        : Option.getOrUndefined(Schema.decodeUnknownOption(ReadFileResult)(call.result))?.content
    return {
      label: "read",
      summary: `${decoded.path}${content === undefined ? "" : ` · ${bytes(utf8Bytes(content))}`}`,
    }
  },
  writeFile: (call: ToolCall): ToolSummary => {
    const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(WriteFileParams)(call.params))
    if (decoded === undefined) return fallback(call)
    return { label: "write", summary: `${decoded.path} · ${bytes(utf8Bytes(decoded.content))}` }
  },
  edit: (call: ToolCall): ToolSummary => {
    const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(EditParams)(call.params))
    if (decoded === undefined) return fallback(call)
    const result = Option.getOrUndefined(Schema.decodeUnknownOption(EditResult)(call.result))
    const editCount = result?.appliedEdits ?? (decoded.edits ? decoded.edits.length : 1)
    return {
      label: "edit",
      summary: `${decoded.path} · ${editCount} edit${editCount === 1 ? "" : "s"}`,
    }
  },
  listFiles: (call: ToolCall): ToolSummary => {
    const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(ListFilesParams)(call.params))
    if (decoded === undefined) return fallback(call)
    const files =
      call.result === undefined
        ? undefined
        : Option.getOrUndefined(Schema.decodeUnknownOption(ListFilesResult)(call.result))?.files
    return {
      label: "list",
      summary: `${decoded.path ?? "."}${files === undefined ? "" : ` · ${files.length} files`}`,
    }
  },
  find: (call: ToolCall): ToolSummary => {
    const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(FindParams)(call.params))
    if (decoded === undefined) return fallback(call)
    const result = Option.getOrUndefined(Schema.decodeUnknownOption(FindResult)(call.result))
    const countStr = result?.totalFiles !== undefined ? ` · ${result.totalFiles} files` : ""
    return {
      label: "find",
      summary: `${decoded.pattern ?? "*"}${decoded.path ? ` in ${decoded.path}` : ""}${countStr}`,
    }
  },
  grep: (call: ToolCall): ToolSummary => {
    const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(GrepParams)(call.params))
    if (decoded === undefined) return fallback(call)
    const result = Option.getOrUndefined(Schema.decodeUnknownOption(GrepResult)(call.result))
    const countStr = result?.totalMatches !== undefined ? ` · ${result.totalMatches} matches` : ""
    return {
      label: "grep",
      summary: `/${decoded.pattern}/${decoded.path ? ` in ${decoded.path}` : ""}${countStr}`,
    }
  },
  bash: (call: ToolCall): ToolSummary => {
    const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(BashParams)(call.params))
    if (decoded === undefined) return fallback(call)
    const exitCode =
      call.result === undefined
        ? undefined
        : Option.getOrUndefined(Schema.decodeUnknownOption(BashResult)(call.result))?.exitCode
    const exit = exitCode === undefined || exitCode === 0 ? "" : ` · exit ${exitCode}`
    return { label: "$", summary: `${line(decoded.command)}${exit}` }
  },
  webFetch: (call: ToolCall): ToolSummary => {
    const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(WebFetchParams)(call.params))
    if (decoded === undefined) return fallback(call)
    const payload =
      call.result === undefined
        ? undefined
        : Option.getOrUndefined(Schema.decodeUnknownOption(WebFetchResult)(call.result))
    const detail =
      payload?.status === undefined
        ? ""
        : ` · ${payload.status} · ${bytes(utf8Bytes(payload.body ?? ""))}${
            payload.truncated === true ? " truncated" : ""
          }`
    return { label: "fetch", summary: `${line(decoded.url)}${detail}` }
  },
  skill: (call: ToolCall): ToolSummary => {
    const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(SkillParams)(call.params))
    if (decoded === undefined) return fallback(call)
    return { label: "skill", summary: decoded.id }
  },
  Subagent: (call: ToolCall): ToolSummary => {
    const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(TaskParams)(call.params))
    if (decoded === undefined) return fallback(call)
    return { label: "Subagent", summary: line(decoded.task) }
  },
  task: (call: ToolCall): ToolSummary => {
    const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(TaskParams)(call.params))
    if (decoded === undefined) return fallback(call)
    return { label: "Subagent", summary: line(decoded.task) }
  },
} satisfies { readonly [name: string]: (call: ToolCall) => ToolSummary }

/** One-line summary of a tool call: a short label plus a compact detail string. */
export const summarizeTool = (call: ToolCall): ToolSummary => {
  switch (call.name) {
    case "readFile":
    case "writeFile":
    case "edit":
    case "listFiles":
    case "find":
    case "grep":
    case "bash":
    case "webFetch":
    case "skill":
    case "Subagent":
    case "task":
      return summaryOf[call.name](call)
    default:
      return fallback(call)
  }
}

const ResultMessage = Schema.Struct({ message: Schema.optionalKey(Schema.String) })
const ResultSummary = Schema.Struct({ summary: Schema.optionalKey(Schema.String) })

/** A failure message from a tool result, when the result carries one. */
export const failureMessage = (outcome: ToolOutcome): string | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(ResultMessage)(outcome.result))?.message

/** The summary a delegation tool returned, when present. */
export const resultSummary = (outcome: ToolOutcome): string | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(ResultSummary)(outcome.result))?.summary
