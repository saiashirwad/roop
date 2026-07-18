import { Prompt, Response } from "effect/unstable/ai"

import type { SessionRecord } from "./SessionStore.ts"

type ToolCallPart = ReturnType<typeof Response.makePart<"tool-call">>
type ToolResultPart = ReturnType<typeof Response.makePart<"tool-result">>
type TextPart = ReturnType<typeof Response.makePart<"text">>
type AssistantPart = TextPart | ToolCallPart

/**
 * Rebuild model-facing chat history from a durable session log.
 * Flushes each tool round before following text so Chat Completions–style APIs
 * never see final text between tool_calls and tool results.
 */
export const promptFromSessionRecords = (
  records: ReadonlyArray<SessionRecord>,
  systemPrompt: string,
): Prompt.Prompt => {
  const messages: Array<Prompt.Message> = [
    Prompt.makeMessage("system", {
      content: systemPrompt,
    }),
  ]

  let pendingText = ""
  let assistantParts: Array<AssistantPart> = []
  let toolResultParts: Array<ToolResultPart> = []
  const openToolCalls = new Map<string, { name: string }>()

  const flushText = () => {
    if (pendingText.length === 0) return
    assistantParts.push(Response.makePart("text", { text: pendingText }))
    pendingText = ""
  }

  const flushRound = () => {
    flushText()

    // Close incomplete tools with synthetic failures so they don't poison the next request.
    if (openToolCalls.size > 0) {
      for (const [id, call] of openToolCalls) {
        toolResultParts.push(
          Response.makePart("tool-result", {
            id,
            name: call.name,
            isFailure: true,
            result: { message: "Tool result missing from session history" },
            encodedResult: { message: "Tool result missing from session history" },
            providerExecuted: false,
            preliminary: false,
          }),
        )
      }
      openToolCalls.clear()
    }

    if (assistantParts.length === 0 && toolResultParts.length === 0) {
      return
    }

    if (assistantParts.length > 0) {
      const turn = Prompt.fromResponseParts(assistantParts)
      for (const message of turn.content) {
        messages.push(message)
      }
    }

    if (toolResultParts.length > 0) {
      const turn = Prompt.fromResponseParts(toolResultParts)
      for (const message of turn.content) {
        messages.push(message)
      }
    }

    assistantParts = []
    toolResultParts = []
  }

  for (const record of records) {
    if (record.entry._tag === "UserPrompt") {
      flushRound()
      const actor = record.entry.actor
      const text = actor !== undefined ? `${actor.name}: ${record.entry.prompt}` : record.entry.prompt
      messages.push(
        Prompt.makeMessage("user", {
          content: [Prompt.makePart("text", { text })],
        }),
      )
      continue
    }

    const event = record.entry.event
    switch (event._tag) {
      case "TextDelta": {
        if (toolResultParts.length > 0) {
          flushRound()
        }
        pendingText += event.delta
        break
      }
      case "ToolCall": {
        flushText()
        if (toolResultParts.length > 0) {
          flushRound()
        }
        assistantParts.push(
          Response.makePart("tool-call", {
            id: event.id,
            name: event.name,
            params: event.params,
            providerExecuted: false,
          }),
        )
        openToolCalls.set(event.id, { name: event.name })
        break
      }
      case "ToolResult": {
        openToolCalls.delete(event.id)
        toolResultParts.push(
          Response.makePart("tool-result", {
            id: event.id,
            name: event.name,
            isFailure: event.isFailure,
            result: event.result,
            encodedResult: event.result,
            providerExecuted: false,
            preliminary: false,
          }),
        )
        break
      }
      case "RunCompleted":
      case "RunFailed":
      case "RunInterrupted": {
        flushRound()
        break
      }
      case "RunStarted":
      case "ReasoningDelta":
      case "ToolProgress":
      case "SubagentStarted":
      case "SubagentCompleted": {
        break
      }
    }
  }

  flushRound()
  return Prompt.fromMessages(messages)
}
