import type { SessionRecord } from "@roop/core/SessionStore.ts"

/** Collapse whitespace and soft-truncate for one-line-ish terminal rows. */
const summarize = (value: unknown, max = 120): string => {
  let text: string
  try {
    text = typeof value === "string" ? value : (JSON.stringify(value) ?? "")
  } catch {
    text = String(value)
  }
  text = text.replace(/\s+/g, " ").trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** First non-empty line, truncated — stacks/TransportError must not dump into the transcript. */
const firstLine = (message: string, max = 160): string => {
  const line = message.split(/\r?\n/).find((l) => l.trim().length > 0) ?? message
  const cleaned = line.replace(/\s+/g, " ").trim()
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned
}

/** One transcript line for a session record. TextDelta is handled by the live buffer. */
export const formatRecord = (record: SessionRecord): string | undefined => {
  if (record.entry._tag === "UserPrompt") {
    const who = record.entry.actor?.name ?? "someone"
    return `${who}> ${record.entry.prompt}`
  }

  const event = record.entry.event
  switch (event._tag) {
    case "RunStarted":
      return "· run started"
    case "TextDelta":
    case "ReasoningDelta":
      return undefined // streamed via live agent buffer
    case "ToolCall":
      return `  [tool] ${event.name} ${summarize(event.params)}`
    case "ToolProgress":
      return `  [progress] ${event.name} ${summarize(event.result, 80)}`
    case "ToolResult":
      return `  [${event.isFailure ? "fail" : "ok"}] ${event.name} ${summarize(event.result)}`
    case "SubagentStarted":
      return `  [sub] start ${event.agentId}`
    case "SubagentCompleted":
      return `  [sub] ${event.status} ${event.agentId}`
    case "RunCompleted":
      return "· done"
    case "RunFailed":
      return `· failed: ${firstLine(event.message)}`
    case "RunInterrupted":
      return "· interrupted"
    default:
      return undefined
  }
}

export const isTextDelta = (
  record: SessionRecord,
): record is SessionRecord & {
  entry: { _tag: "Agent"; event: { _tag: "TextDelta"; delta: string } }
} => record.entry._tag === "Agent" && record.entry.event._tag === "TextDelta"
