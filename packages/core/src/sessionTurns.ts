import type { AgentEvent } from "./AgentEvent.ts"
import type { SessionRecord } from "./SessionStore.ts"

export type SubagentRef = {
  readonly agentId: string
  readonly childSessionId: string
  readonly childRunId?: string
  readonly status: "running" | "completed" | "failed" | "interrupted"
}

export type Block =
  | { readonly kind: "reasoning"; readonly text: string }
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "tool"
      readonly id: string
      readonly name: string
      readonly params: unknown
      readonly result?: unknown
      readonly isFailure?: boolean
      readonly status: "running" | "done"
      readonly subagent?: SubagentRef
    }

export type Turn = {
  readonly id: string
  readonly role: "user" | "assistant"
  readonly blocks: ReadonlyArray<Block>
  readonly error?: string
}

const readSubagentFields = (
  value: unknown,
):
  | {
      readonly agentId?: string
      readonly childSessionId?: string
      readonly childRunId?: string
      readonly status?: SubagentRef["status"]
    }
  | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  const obj = value as Record<string, unknown>
  return {
    ...(typeof obj.agentId === "string" ? { agentId: obj.agentId } : {}),
    ...(typeof obj.childSessionId === "string" ? { childSessionId: obj.childSessionId } : {}),
    ...(typeof obj.childRunId === "string" ? { childRunId: obj.childRunId } : {}),
    ...(obj.status === "running" ||
    obj.status === "completed" ||
    obj.status === "failed" ||
    obj.status === "interrupted"
      ? { status: obj.status }
      : {}),
  }
}

const mergeSubagent = (
  existing: SubagentRef | undefined,
  patch: {
    readonly agentId?: string
    readonly childSessionId?: string
    readonly childRunId?: string
    readonly status?: SubagentRef["status"]
  },
): SubagentRef | undefined => {
  const agentId = patch.agentId ?? existing?.agentId
  const childSessionId = patch.childSessionId ?? existing?.childSessionId
  if (agentId === undefined || childSessionId === undefined) {
    return existing
  }
  const childRunId = patch.childRunId ?? existing?.childRunId
  const merged: SubagentRef = {
    agentId,
    childSessionId,
    status: patch.status ?? existing?.status ?? "running",
    ...(childRunId !== undefined ? { childRunId } : {}),
  }
  return merged
}

const withSubagent = (
  tool: Extract<Block, { kind: "tool" }>,
  subagent: SubagentRef | undefined,
): Extract<Block, { kind: "tool" }> => {
  if (subagent === undefined) {
    const { subagent: _drop, ...rest } = tool
    return rest
  }
  return { ...tool, subagent }
}

const updateToolBlock = (
  blocks: Array<Block>,
  toolId: string,
  update: (tool: Extract<Block, { kind: "tool" }>) => Extract<Block, { kind: "tool" }>,
): boolean => {
  const index = blocks.findIndex((block) => block.kind === "tool" && block.id === toolId)
  if (index < 0) return false
  const existing = blocks[index]
  if (existing === undefined || existing.kind !== "tool") return false
  blocks[index] = update(existing)
  return true
}

/** Fallback link when parentToolCallId does not match a tool block. */
const linkByChildSessionId = (
  blocks: Array<Block>,
  childSessionId: string,
  patch: {
    readonly agentId?: string
    readonly childSessionId?: string
    readonly childRunId?: string
    readonly status?: SubagentRef["status"]
  },
): boolean => {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (block?.kind === "tool" && block.subagent?.childSessionId === childSessionId) {
      blocks[i] = withSubagent(block, mergeSubagent(block.subagent, patch))
      return true
    }
  }
  return false
}

export function applyEvent(turn: Turn, event: AgentEvent): Turn {
  if (event._tag === "RunFailed") {
    return { ...turn, error: event.message }
  }
  if (event._tag === "RunInterrupted") {
    return { ...turn, error: `Interrupted (${event.runId})` }
  }

  const blocks = [...turn.blocks]
  const last = blocks[blocks.length - 1]

  switch (event._tag) {
    case "ReasoningDelta": {
      if (last !== undefined && last.kind === "reasoning") {
        blocks[blocks.length - 1] = { ...last, text: last.text + event.delta }
      } else {
        blocks.push({ kind: "reasoning", text: event.delta })
      }
      break
    }
    case "TextDelta": {
      if (last !== undefined && last.kind === "text") {
        blocks[blocks.length - 1] = { ...last, text: last.text + event.delta }
      } else {
        blocks.push({ kind: "text", text: event.delta })
      }
      break
    }
    case "ToolCall": {
      blocks.push({
        kind: "tool",
        id: event.id,
        name: event.name,
        params: event.params,
        status: "running",
      })
      break
    }
    case "ToolProgress": {
      const fields = readSubagentFields(event.result)
      const found = updateToolBlock(blocks, event.id, (existing) =>
        withSubagent(
          { ...existing, result: event.result },
          mergeSubagent(existing.subagent, {
            ...fields,
            status: "running",
          }),
        ),
      )
      if (!found) {
        const subagent =
          fields?.childSessionId !== undefined && fields.agentId !== undefined
            ? mergeSubagent(undefined, {
                agentId: fields.agentId,
                childSessionId: fields.childSessionId,
                ...(fields.childRunId !== undefined ? { childRunId: fields.childRunId } : {}),
                status: "running",
              })
            : undefined
        blocks.push(
          withSubagent(
            {
              kind: "tool",
              id: event.id,
              name: event.name,
              params: {},
              result: event.result,
              status: "running",
            },
            subagent,
          ),
        )
      }
      break
    }
    case "ToolResult": {
      const fields = readSubagentFields(event.result)
      const found = updateToolBlock(blocks, event.id, (existing) =>
        withSubagent(
          {
            ...existing,
            result: event.result,
            isFailure: event.isFailure,
            status: "done",
          },
          mergeSubagent(existing.subagent, {
            ...fields,
            status: fields?.status ?? (event.isFailure ? "failed" : "completed"),
          }),
        ),
      )
      if (!found) {
        const subagent =
          fields?.childSessionId !== undefined && fields.agentId !== undefined
            ? mergeSubagent(undefined, {
                agentId: fields.agentId,
                childSessionId: fields.childSessionId,
                ...(fields.childRunId !== undefined ? { childRunId: fields.childRunId } : {}),
                status: fields.status ?? (event.isFailure ? "failed" : "completed"),
              })
            : undefined
        blocks.push(
          withSubagent(
            {
              kind: "tool",
              id: event.id,
              name: event.name,
              params: {},
              result: event.result,
              isFailure: event.isFailure,
              status: "done",
            },
            subagent,
          ),
        )
      }
      break
    }
    case "SubagentStarted": {
      const patch = {
        agentId: event.agentId,
        childSessionId: event.childSessionId,
        childRunId: event.childRunId,
        status: "running" as const,
      }
      const byId = updateToolBlock(blocks, event.parentToolCallId, (existing) =>
        withSubagent(existing, mergeSubagent(existing.subagent, patch)),
      )
      if (!byId) {
        linkByChildSessionId(blocks, event.childSessionId, patch)
      }
      break
    }
    case "SubagentCompleted": {
      const patch = {
        agentId: event.agentId,
        childSessionId: event.childSessionId,
        status: event.status,
      }
      const byId = updateToolBlock(blocks, event.parentToolCallId, (existing) =>
        withSubagent(existing, mergeSubagent(existing.subagent, patch)),
      )
      if (!byId) {
        linkByChildSessionId(blocks, event.childSessionId, patch)
      }
      break
    }
    default:
      break
  }

  return { ...turn, blocks }
}

export function applyRecord(
  turns: ReadonlyArray<Turn>,
  record: SessionRecord,
): ReadonlyArray<Turn> {
  if (record.entry._tag === "UserPrompt") {
    return [
      ...turns,
      {
        id: record.id,
        role: "user",
        blocks: [{ kind: "text", text: record.entry.prompt }],
      },
    ]
  }

  const event = record.entry.event

  if (event._tag === "RunStarted") {
    return [...turns, { id: record.id, role: "assistant", blocks: [] }]
  }

  if (event._tag === "RunCompleted") {
    return turns
  }

  let openIndex = -1
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!
    if (turn.role === "user") break
    if (turn.role === "assistant") {
      openIndex = i
      break
    }
  }

  const next = [...turns]
  if (openIndex < 0) {
    next.push({ id: record.id, role: "assistant", blocks: [] })
    openIndex = next.length - 1
  }

  next[openIndex] = applyEvent(next[openIndex]!, event)
  return next
}

export function turnsFromRecords(records: ReadonlyArray<SessionRecord>): ReadonlyArray<Turn> {
  return records.reduce<ReadonlyArray<Turn>>((turns, record) => applyRecord(turns, record), [])
}
