/** One-line REPL summaries for pack tool calls/results; unknown tools use a compact fallback. */

type Dict = Record<string, unknown>

const asDict = (value: unknown): Dict =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Dict) : {}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined)

export const clip = (text: string, max = 80): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

const countLines = (text: string): number => (text.length === 0 ? 0 : text.split("\n").length)

const shortId = (value: unknown): string => {
  const id = str(value) ?? ""
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}

const genericParams = (params: Dict): string =>
  clip(
    Object.entries(params)
      .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join(" "),
  )

export const formatToolCall = (name: string, params: unknown): string => {
  const p = asDict(params)
  switch (name) {
    case "readFile":
    case "writeFile":
    case "editFile":
    case "applyPatch": {
      return str(p.path) ?? ""
    }
    case "listFiles": {
      return `${str(p.path) ?? "."}${p.recursive === true ? " (recursive)" : ""}`
    }
    case "grep": {
      return `"${clip(str(p.pattern) ?? "", 50)}" in ${str(p.path) ?? "."}`
    }
    case "bash": {
      return clip(str(p.command) ?? "")
    }
    case "gitStatus": {
      return ""
    }
    case "gitDiff": {
      return str(p.path) ?? (p.staged === true ? "staged" : "worktree")
    }
    case "gitLog": {
      return ""
    }
    case "spawnAgent": {
      const background = p.background === true ? " (background)" : ""
      return `${str(p.agent) ?? "?"}${background} “${clip(str(p.task) ?? "", 70)}”`
    }
    case "sendToAgent": {
      return `${shortId(p.sessionId)} “${clip(str(p.prompt) ?? "", 70)}”`
    }
    case "awaitAgents": {
      const ids = Array.isArray(p.runIds) ? p.runIds.length : 0
      const mode = str(p.mode) ?? "all"
      return `${ids} run${ids === 1 ? "" : "s"} (${mode})`
    }
    case "checkAgent":
    case "stopAgent": {
      return shortId(p.runId)
    }
    default: {
      return genericParams(p)
    }
  }
}

export const formatToolResult = (name: string, result: unknown, isFailure: boolean): string => {
  const r = asDict(result)
  if (isFailure) {
    const reason = str(r.reason)
    const message = str(r.message) ?? clip(JSON.stringify(result ?? ""))
    return reason === undefined ? clip(message) : `${reason}: ${clip(message)}`
  }
  switch (name) {
    case "readFile": {
      const content = str(r.content)
      return content === undefined ? "" : `${countLines(content)} lines`
    }
    case "listFiles": {
      const shown = Array.isArray(r.entries) ? r.entries.length : 0
      const total = num(r.totalEntries) ?? shown
      return r.truncated === true ? `${shown} of ${total} entries` : `${shown} entries`
    }
    case "writeFile": {
      return `${num(r.bytesWritten) ?? 0}B ${r.created === true ? "created" : "written"}`
    }
    case "editFile": {
      const n = num(r.replacements) ?? 0
      return `${n} replacement${n === 1 ? "" : "s"} · +${num(r.linesAdded) ?? 0}/−${num(r.linesRemoved) ?? 0}`
    }
    case "applyPatch": {
      return `${str(r.mode) ?? "update"} · ${num(r.hunksApplied) ?? 0} hunks · +${num(r.linesAdded) ?? 0}/−${num(r.linesRemoved) ?? 0}`
    }
    case "bash": {
      const firstLine = (str(r.stdout) ?? "").split("\n", 1)[0] ?? ""
      const exit = `exit ${num(r.exitCode) ?? "?"}`
      return firstLine.trim() === "" ? exit : `${exit} · ${clip(firstLine, 60)}`
    }
    case "grep": {
      const matches = Array.isArray(r.matches) ? r.matches : []
      const files = new Set(matches.map((match) => str(asDict(match).path) ?? "")).size
      const total = num(r.totalMatches) ?? matches.length
      return `${total} match${total === 1 ? "" : "es"} in ${files} file${files === 1 ? "" : "s"}`
    }
    case "gitStatus": {
      const changed = (str(r.porcelain) ?? "").split("\n").filter((line) => line !== "").length
      return `${clip(str(r.branchLine) ?? "", 40)} · ${changed} changed`
    }
    case "gitDiff": {
      return `${countLines(str(r.diff) ?? "")} diff lines`
    }
    case "gitLog": {
      return `${countLines(str(r.log) ?? "")} lines`
    }
    case "spawnAgent":
    case "sendToAgent": {
      const status = str(r.status) ?? "?"
      if (status === "running") {
        return `running · run ${shortId(r.childRunId)}`
      }
      const summary = clip(str(r.summary) ?? "", 90)
      return summary === "" ? status : `${status} · ${summary}`
    }
    case "awaitAgents": {
      const settled = Array.isArray(r.results) ? r.results.length : 0
      const pending = Array.isArray(r.pending) ? r.pending.length : 0
      return pending === 0 ? `${settled} settled` : `${settled} settled · ${pending} pending`
    }
    case "checkAgent": {
      const state = r.running === true ? "running" : "idle"
      const last = clip(str(r.lastText) ?? "", 70)
      return last === "" ? state : `${state} · ${last}`
    }
    case "stopAgent": {
      return r.stopped === true ? "stopped" : "not running"
    }
    default: {
      try {
        return clip(JSON.stringify(result))
      } catch {
        return clip(String(result))
      }
    }
  }
}
