import { Array as Arr, Option } from "effect"
import { Prompt } from "effect/unstable/ai"

import { EVENT_VERSION, type JournalEvent, type LifecycleState } from "./Event.ts"

/** The pure result of projecting a committed Journal prefix. */
export interface History {
  readonly events: ReadonlyArray<JournalEvent>
  readonly messages: ReadonlyArray<Prompt.Message>
  readonly openSpans: ReadonlyArray<string>
}

type ToolRecord = Extract<JournalEvent, { readonly _tag: "tool/call" | "tool/result" }>

const toolRecordKey = (event: ToolRecord): string =>
  `${event.runId ?? "legacy"}:${event.turn ?? 0}:${event.step ?? 0}:${event.id}`

const isTerminal = (state: LifecycleState): boolean =>
  state === "completed" || state === "aborted" || state === "recovered"

type SpanEvent = Extract<
  JournalEvent,
  { readonly _tag: "run" | "turn" | "step" | "model/attempt" | "tool" }
>

const spanKey = (event: SpanEvent): string => {
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
  }
}

const spanEvent = (event: JournalEvent): Option.Option<SpanEvent> => {
  switch (event._tag) {
    case "run":
    case "turn":
    case "step":
    case "model/attempt":
    case "tool":
      return Option.some(event)
    default:
      return Option.none()
  }
}

/** Walk the span lifecycle, keeping the still-open `started` events by key. */
const openSpans = (events: ReadonlyArray<JournalEvent>): Map<string, SpanEvent> => {
  const open = new Map<string, SpanEvent>()
  for (const event of Arr.getSomes(events.map(spanEvent))) {
    const key = spanKey(event)
    if (event.state === "started") open.set(key, event)
    else if (isTerminal(event.state)) open.delete(key)
  }
  return open
}

const toMessages = (events: ReadonlyArray<JournalEvent>): ReadonlyArray<Prompt.Message> => {
  const messages: Array<Prompt.Message> = []
  let assistantParts: Array<Prompt.AssistantMessagePart> = []
  let toolParts: Array<Prompt.ToolMessagePart> = []
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
        if (!pendingCalls.delete(toolRecordKey(event))) break
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

/**
 * The deterministic semantic projection of a committed event prefix.
 * Pure: it does not load, append, or otherwise access storage.
 */
export const fromEvents = (events: ReadonlyArray<JournalEvent>): History => ({
  events,
  messages: toMessages(events),
  openSpans: [...openSpans(events).keys()],
})

/** The model-facing prompt of a history. */
export const toPrompt = (history: History | ReadonlyArray<JournalEvent>): Prompt.Prompt =>
  Prompt.fromMessages("messages" in history ? history.messages : toMessages(history))

const recoveredState = (event: SpanEvent): JournalEvent => {
  switch (event._tag) {
    case "run":
    case "turn":
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
  }
}

/** Innermost spans close first. */
const closeOrder: Record<SpanEvent["_tag"], number> = {
  tool: 0,
  "model/attempt": 1,
  step: 2,
  turn: 3,
  run: 4,
}

/** Events required to close every open span before a resumed run starts work. */
export const recoveryEvents = (
  events: ReadonlyArray<JournalEvent>,
): ReadonlyArray<JournalEvent> => {
  const calls = new Map<string, Extract<JournalEvent, { readonly _tag: "tool/call" }>>()
  const results = new Set<string>()
  for (const event of events) {
    if (event._tag === "tool/call") calls.set(toolRecordKey(event), event)
    if (event._tag === "tool/result") results.add(toolRecordKey(event))
  }

  const unresolved: Array<JournalEvent> = []
  for (const [key, call] of calls) {
    if (results.has(key)) continue
    unresolved.push({
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

  const closed = [...openSpans(events).values()]
    .sort((left, right) => closeOrder[left._tag] - closeOrder[right._tag])
    .map(recoveredState)
  return [...unresolved, ...closed]
}

export const History = Object.assign(fromEvents, { fromEvents, toPrompt, recoveryEvents })
