import { Context, Effect, Layer, Queue, Ref, Schema, Semaphore, Stream } from "effect"

import { AgentEvent, type SessionEvent } from "./AgentEvents.ts"
import { SessionId } from "./DomainIds.ts"

/* ========================================================================== *
 * Schemas & Envelopes                                                        *
 * ========================================================================== */

/**
 * Envelope carried across the agent event pub/sub bus.
 */
export const AgentBusEnvelope = Schema.Struct({
  sessionId: SessionId,
  event: AgentEvent,
})
export type AgentBusEnvelope = typeof AgentBusEnvelope.Type

/* ========================================================================== *
 * SessionEvent to AgentEvent Projection                                      *
 * ========================================================================== */

/**
 * Pure projection from journaled SessionEvents to streamable AgentEvents.
 */
export const sessionEventsToAgentEvents = (
  events: ReadonlyArray<SessionEvent>,
  replayFromStep?: number | undefined,
): Array<AgentEvent> => {
  const result: Array<AgentEvent> = []
  const eligible: Array<SessionEvent> = []
  let currentStep = 0

  for (const event of events) {
    if (event._tag === "step/start") {
      currentStep = event.index
    }
    if (replayFromStep !== undefined && currentStep < replayFromStep) {
      continue
    }
    eligible.push(event)
  }

  let lastTurnEnd = -1
  for (let index = 0; index < eligible.length; index += 1) {
    if (eligible[index]?._tag === "turn/end") lastTurnEnd = index
  }

  for (let index = 0; index < eligible.length; index += 1) {
    const event = eligible[index]!

    switch (event._tag) {
      case "assistant/message": {
        for (const part of event.parts) {
          if (part.type === "text") {
            result.push({ _tag: "TextDelta", delta: part.text })
          } else if (part.type === "reasoning") {
            result.push({ _tag: "ReasoningDelta", delta: part.text })
          }
        }
        break
      }
      case "tool/call": {
        const item: AgentEvent = {
          _tag: "ToolCall",
          id: event.id,
          name: event.name,
          params: event.params,
          ...(event.providerExecuted === undefined
            ? undefined
            : { providerExecuted: event.providerExecuted }),
        }
        result.push(item)
        break
      }
      case "tool/result": {
        const item: AgentEvent = {
          _tag: "ToolResult",
          id: event.id,
          name: event.name,
          isFailure: event.isFailure,
          result: event.result,
          ...(event.providerExecuted === undefined
            ? undefined
            : { providerExecuted: event.providerExecuted }),
        }
        result.push(item)
        break
      }
      case "turn/end": {
        // A continued/steered turn is an intermediate journal marker. Only
        // the final marker represents the stream's terminal Finish event.
        if (index !== lastTurnEnd) break
        const finish: AgentEvent = {
          _tag: "Finish",
          reason: event.reason,
          ...(event.message === undefined ? undefined : { message: event.message }),
        }
        result.push(finish)
        break
      }
    }
  }

  return result
}

/* ========================================================================== *
 * Capability Seam: AgentBus                                                  *
 * ========================================================================== */

export interface AgentBusService {
  /**
   * Publishes an event envelope onto the bus.
   */
  readonly publish: (envelope: AgentBusEnvelope) => Effect.Effect<void>

  /**
   * Subscribes to live agent events, optionally filtering by sessionId.
   */
  readonly subscribe: (
    sessionId?: SessionId | string,
    options?: { readonly liveOnly?: boolean | undefined },
  ) => Effect.Effect<Stream.Stream<AgentEvent>>
}

export class AgentBus extends Context.Service<AgentBus, AgentBusService>()("roop/AgentBus") {
  /**
   * In-memory session log plus live queues. Registration and publishing share
   * one lock, so a subscriber gets an atomic history/live boundary.
   */
  static readonly memory: Layer.Layer<AgentBus> = Layer.effect(
    AgentBus,
    Effect.gen(function* () {
      type Subscriber = {
        readonly sessionId: string | undefined
        readonly queue: Queue.Queue<AgentEvent>
      }
      const history = yield* Ref.make<Map<string, Array<AgentEvent>>>(new Map())
      const subscribers = yield* Ref.make<Map<number, Subscriber>>(new Map())
      const nextId = yield* Ref.make(0)
      const lock = yield* Semaphore.make(1)

      return AgentBus.of({
        publish: (envelope) =>
          lock
            .withPermits(1)(
              Effect.gen(function* () {
                const sid = String(envelope.sessionId)
                yield* Ref.update(history, (entries) => {
                  const next = new Map(entries)
                  const previous = next.get(sid) ?? []
                  const base = previous.at(-1)?._tag === "Finish" ? [] : previous
                  next.set(sid, [...base, envelope.event])
                  return next
                })
                const current = yield* Ref.get(subscribers)
                yield* Effect.forEach(current.values(), (subscriber) =>
                  subscriber.sessionId === undefined || subscriber.sessionId === sid
                    ? Queue.offer(subscriber.queue, envelope.event)
                    : Effect.void,
                )
              }),
            )
            .pipe(Effect.asVoid),
        subscribe: (sessionId, options) => {
          const sid = sessionId !== undefined ? String(SessionId.make(sessionId)) : undefined
          return lock.withPermits(1)(
            Effect.gen(function* () {
              const queue = yield* Queue.unbounded<AgentEvent>()
              const id = yield* Ref.modify(nextId, (value) => [value, value + 1] as const)
              const entries = sid === undefined ? [] : ((yield* Ref.get(history)).get(sid) ?? [])
              let lastFinish = -1
              for (let index = 0; index < entries.length; index += 1) {
                if (entries[index]?._tag === "Finish") lastFinish = index
              }
              const past = options?.liveOnly === true ? [] : entries.slice(lastFinish + 1)
              yield* Ref.update(subscribers, (entries) => {
                const next = new Map(entries)
                next.set(id, { sessionId: sid, queue })
                return next
              })
              return Stream.concat(Stream.fromIterable(past), Stream.fromQueue(queue)).pipe(
                Stream.ensuring(
                  lock.withPermits(1)(
                    Effect.gen(function* () {
                      yield* Ref.update(subscribers, (entries) => {
                        const next = new Map(entries)
                        next.delete(id)
                        return next
                      })
                      yield* Queue.shutdown(queue)
                    }),
                  ),
                ),
              )
            }),
          )
        },
      })
    }),
  )
}

export const AgentBusMemory = AgentBus.memory
