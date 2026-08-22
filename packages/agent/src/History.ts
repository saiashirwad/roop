/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: legacy SessionEvent values cross the temporary compatibility JSON boundary; the new JournalEvent path is schema-validated. */

import { Prompt } from "effect/unstable/ai"

import type { SessionEvent } from "./AgentEvents.ts"
import { EVENT_VERSION, type JournalEvent, type LiveEvent, type LifecycleState } from "./Event.ts"

/** The pure result of projecting a committed Journal prefix. */
export interface History {
  readonly events: ReadonlyArray<JournalEvent>
  readonly messages: ReadonlyArray<Prompt.Message>
  readonly openSpans: ReadonlyArray<string>
}

/** Input accepted while the old SessionEvent bridge is being removed. */
export type HistoryEvent = JournalEvent | SessionEvent

type AssistantPart = Prompt.AssistantMessagePart
type ToolPart = Prompt.ToolMessagePart

type ToolRecord = Extract<JournalEvent, { readonly _tag: "tool/call" | "tool/result" }>

const toolRecordKey = (event: ToolRecord): string =>
  `${event.runId ?? "legacy"}:${event.turn ?? 0}:${event.step ?? 0}:${event.id}`

const isJournalEvent = (event: HistoryEvent): event is JournalEvent => "version" in event

const isTerminal = (state: LifecycleState): boolean =>
  state === "completed" || state === "aborted" || state === "recovered"

type SpanEvent = Extract<
  JournalEvent,
  { readonly _tag: "run" | "turn" | "step" | "model/attempt" | "tool" }
>

const isSpanEvent = (event: JournalEvent): event is SpanEvent =>
  event._tag === "run" ||
  event._tag === "turn" ||
  event._tag === "step" ||
  event._tag === "model/attempt" ||
  event._tag === "tool"

const spanKey = (event: JournalEvent): string | undefined => {
  switch (event._tag) {
    case "run":
      return `run:${event.runId}`
    case "turn":
      return `turn:${event.runId}:${event.turn}`
    case "step":
      return `step:${event.runId}:${event.turn}:${event.step}`
    case "model/attempt":
      return `attempt:${event.runId}:${event.turn}:${event.step}:${event.attempt}`
    case "tool":
      return `tool:${event.runId}:${event.turn}:${event.step}:${event.id}`
    default:
      return undefined
  }
}

const appendMessages = (events: ReadonlyArray<JournalEvent>): ReadonlyArray<Prompt.Message> => {
  const messages: Array<Prompt.Message> = []
  let assistantParts: Array<AssistantPart> = []
  let toolParts: Array<ToolPart> = []
  const pendingCalls = new Set<string>()

  const flushTool = () => {
    if (toolParts.length === 0) return
    messages.push(Prompt.makeMessage("tool", { content: toolParts }))
    toolParts = []
  }
  const flushAssistant = () => {
    if (assistantParts.length === 0) return
    messages.push(Prompt.makeMessage("assistant", { content: assistantParts }))
    assistantParts = []
  }
  const flushAll = () => {
    flushTool()
    // A call without a result is not a committed model-visible message.
    assistantParts = assistantParts.filter((part) => part.type !== "tool-call")
    flushAssistant()
  }

  for (const event of events) {
    switch (event._tag) {
      case "system/message":
        flushAll()
        messages.push(Prompt.makeMessage("system", { content: event.content }))
        break
      case "user/message":
        flushAll()
        messages.push(
          Prompt.makeMessage("user", {
            content: [Prompt.makePart("text", { text: event.content })],
          }),
        )
        break
      case "assistant/message":
        flushTool()
        for (const part of event.parts) {
          assistantParts.push(Prompt.makePart(part.type, { text: part.text }))
        }
        break
      case "tool/call":
        pendingCalls.add(toolRecordKey(event))
        assistantParts.push(
          Prompt.makePart("tool-call", {
            id: event.id,
            name: event.name,
            params: event.params,
            providerExecuted: event.providerExecuted ?? false,
          }),
        )
        break
      case "tool/result":
        if (!pendingCalls.has(toolRecordKey(event))) break
        pendingCalls.delete(toolRecordKey(event))
        flushAssistant()
        toolParts.push(
          Prompt.makePart("tool-result", {
            id: event.id,
            name: event.name,
            isFailure: event.isFailure,
            result: event.result,
          }),
        )
        break
      default:
        break
    }
  }
  flushAll()
  return messages
}

const legacyToJournal = (event: SessionEvent): JournalEvent | undefined => {
  switch (event._tag) {
    case "system/message":
      return { _tag: "system/message", version: EVENT_VERSION, content: event.content }
    case "user/message":
      return { _tag: "user/message", version: EVENT_VERSION, content: event.content }
    case "assistant/message":
      return { _tag: "assistant/message", version: EVENT_VERSION, parts: event.parts }
    case "tool/call":
      return {
        _tag: "tool/call",
        version: EVENT_VERSION,
        id: event.id,
        name: event.name,
        params: event.params as never,
        ...(event.providerExecuted === undefined
          ? undefined
          : { providerExecuted: event.providerExecuted }),
      }
    case "tool/result":
      return {
        _tag: "tool/result",
        version: EVENT_VERSION,
        id: event.id,
        name: event.name,
        isFailure: event.isFailure,
        result: event.result as never,
        ...(event.providerExecuted === undefined
          ? undefined
          : { providerExecuted: event.providerExecuted }),
      }
    case "model/request":
      return {
        _tag: "model/request",
        version: EVENT_VERSION,
        runId: "legacy",
        turn: 0,
        step: 0,
        requestId: "legacy",
        request: event.request as never,
        planFingerprint: "legacy",
        promptFingerprint: "legacy",
        toolFingerprint: "legacy",
        toolNames: [],
      }
    default:
      return undefined
  }
}

const normalize = (events: ReadonlyArray<HistoryEvent>): Array<JournalEvent> => {
  const normalized = events.flatMap((event) =>
    isJournalEvent(event) ? [event] : [legacyToJournal(event)].filter(Boolean),
  )
  return normalized.filter((event): event is JournalEvent => event !== undefined)
}

/**
 * Return the deterministic semantic projection of a committed event prefix.
 * This function is pure. It does not load, append, or otherwise access storage.
 */
export const fromEvents = (events: ReadonlyArray<HistoryEvent>): History => {
  const normalized = normalize(events)
  const open = new Set<string>()
  for (const event of normalized) {
    const key = spanKey(event)
    if (key === undefined) continue
    if (!isSpanEvent(event)) continue
    if (event.state === "started") open.add(key)
    else if (isTerminal(event.state)) open.delete(key)
  }
  return {
    events: normalized,
    messages: appendMessages(normalized),
    openSpans: [...open],
  }
}

/** Convert a history or event sequence to the model-facing prompt. */
const isHistory = (input: History | ReadonlyArray<HistoryEvent>): input is History =>
  !Array.isArray(input)

export const toPrompt = (history: History | ReadonlyArray<HistoryEvent>): Prompt.Prompt =>
  Prompt.fromMessages(fromEvents(isHistory(history) ? history.events : history).messages)

const recoveredState = (event: JournalEvent): JournalEvent | undefined => {
  switch (event._tag) {
    case "run":
      return { ...event, state: "recovered", reason: "interrupted" }
    case "turn":
      return { ...event, state: "recovered", reason: "interrupted" }
    case "step":
      return { ...event, state: "recovered", reason: "interrupted" }
    case "model/attempt":
      return { ...event, state: "recovered", message: "recovered before completion" }
    case "tool":
      return {
        ...event,
        state: "recovered",
        isFailure: true,
        result: { type: "execution-unknown" },
        failureReason: "execution-unknown",
      }
    default:
      return undefined
  }
}

/** Events required to close every open span before a resumed run starts work. */
export const recoveryEvents = (
  events: ReadonlyArray<HistoryEvent>,
): ReadonlyArray<JournalEvent> => {
  const normalized = normalize(events)
  const open = new Map<string, JournalEvent>()
  const calls = new Map<string, Extract<JournalEvent, { readonly _tag: "tool/call" }>>()
  const results = new Set<string>()
  for (const event of normalized) {
    const key = spanKey(event)
    if (key !== undefined && isSpanEvent(event)) {
      if (event.state === "started") open.set(key, event)
      else if (isTerminal(event.state)) open.delete(key)
    }
    if (event._tag === "tool/call") calls.set(toolRecordKey(event), event)
    if (event._tag === "tool/result") results.add(toolRecordKey(event))
  }

  const recovered: Array<JournalEvent> = []
  for (const [key, call] of calls) {
    if (results.has(key)) continue
    recovered.push({
      _tag: "tool/result",
      version: EVENT_VERSION,
      ...(call.runId === undefined ? undefined : { runId: call.runId }),
      ...(call.turn === undefined ? undefined : { turn: call.turn }),
      ...(call.step === undefined ? undefined : { step: call.step }),
      id: call.id,
      name: call.name,
      isFailure: true,
      result: { type: "execution-unknown" },
      failureReason: "execution-unknown",
    })
  }

  const ordered = [...open.values()].sort((left, right) => {
    const rank = (event: JournalEvent): number =>
      event._tag === "tool"
        ? 0
        : event._tag === "model/attempt"
          ? 1
          : event._tag === "step"
            ? 2
            : event._tag === "turn"
              ? 3
              : 4
    return rank(left) - rank(right)
  })
  for (const event of ordered) {
    const closure = recoveredState(event)
    if (closure !== undefined) recovered.push(closure)
  }
  return recovered
}

/** Project semantic journal records into the versioned live event union. */
export const projectLiveEvents = (events: ReadonlyArray<HistoryEvent>): ReadonlyArray<LiveEvent> =>
  normalize(events) as ReadonlyArray<LiveEvent>

export const History = Object.assign(fromEvents, {
  fromEvents,
  toPrompt,
  recoveryEvents,
  projectLiveEvents,
})
