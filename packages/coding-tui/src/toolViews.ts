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

const todoIcon: Record<string, string> = {
  pending: dim("\uf10c"),
  active: cyan("\uf192"),
  done: green("\uf00c"),
}

export const toolViews: Record<string, ToolView> = {
  readFile: ({ params, result }) => {
    /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
    const { path } = params as { path: string }
    /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
    const { content } = (result ?? {}) as { content?: string }
    const size = content === undefined ? "" : dim(` · ${bytes(content.length)}`)
    return `${cyan("\uf15b")} ${bold("read")} ${path}${size}`
  },
  writeFile: ({ params }) => {
    /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
    const { path, content } = params as { path: string; content: string }
    return `${cyan("\uf040")} ${bold("write")} ${path}${dim(` · ${bytes(content.length)}`)}`
  },
  listFiles: ({ params, result }) => {
    /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
    const { path } = params as { path?: string }
    /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
    const { files } = (result ?? {}) as { files?: ReadonlyArray<string> }
    const count = files === undefined ? "" : dim(` · ${files.length} files`)
    return `${cyan("\uf115")} ${bold("list")} ${path ?? "."}${count}`
  },
  bash: ({ params, result }) => {
    /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
    const { command } = params as { command: string }
    /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
    const { exitCode } = (result ?? {}) as { exitCode?: number }
    const exit = exitCode === undefined ? "" : exitCode === 0 ? "" : yellow(` · exit ${exitCode}`)
    return `${cyan("\uf120")} ${bold("$")} ${line(command)}${exit}`
  },
  webFetch: ({ params, result }) => {
    /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
    const { url } = params as { url: string }
    /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
    const { status, body, truncated } = (result ?? {}) as {
      status?: number
      body?: string
      truncated?: boolean
    }
    const summary =
      status === undefined
        ? ""
        : dim(` · ${status} · ${bytes(body?.length ?? 0)}${truncated === true ? " truncated" : ""}`)
    return `${cyan("\uf0ac")} ${bold("fetch")} ${line(url)}${summary}`
  },
  writeTodos: ({ params }) => {
    /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
    const { todos } = params as {
      todos: ReadonlyArray<{ text: string; state: "pending" | "active" | "done" }>
    }
    const items = todos.map(
      (todo) => `  ${todoIcon[todo.state]} ${todo.state === "done" ? dim(todo.text) : todo.text}`,
    )
    return [`${cyan("\uf0ae")} ${bold("todos")}`, ...items].join("\n")
  },
  task: ({ params }) => {
    /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
    const { task } = params as { task: string }
    return `${cyan("\uf126")} ${bold("task")} ${line(task)}`
  },
}

const fallbackView: ToolView = ({ name, params }) => {
  /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
  const entries = Object.entries((params ?? {}) as Record<string, unknown>).map(
    ([key, value]) =>
      `${key}: ${line(typeof value === "string" ? value : JSON.stringify(value), 40)}`,
  )
  return `${cyan("\uf013")} ${bold(name)}${entries.length > 0 ? dim(` ${entries.join(" · ")}`) : ""}`
}

export const renderToolCall = (data: ToolCallData): string => {
  const failed = data.isFailure === true
  const view = toolViews[data.name] ?? fallbackView
  const body = view(failed ? { ...data, result: undefined, isFailure: false } : data)
  const status =
    data.result === undefined ? dim("\uf10c") : failed ? red("\uf00d") : green("\uf00c")
  /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
  const message = (data.result as { message?: string } | undefined)?.message
  const failure = failed && message !== undefined ? `\n  ${red(line(message, 120))}` : ""
  return `${status} ${body}${failure}`
}
