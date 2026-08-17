import { Context, Effect, Layer, PubSub, Schema, Stream } from "effect"

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
  let currentStep = 0

  for (const event of events) {
    if (event._tag === "step/start") {
      currentStep = event.index
    }
    if (replayFromStep !== undefined && currentStep < replayFromStep) {
      continue
    }

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
  readonly subscribe: (sessionId?: SessionId | string) => Stream.Stream<AgentEvent>
}

export class AgentBus extends Context.Service<AgentBus, AgentBusService>()("roop/AgentBus") {
  /**
   * In-Memory Unbounded PubSub Provider.
   */
  static readonly memory: Layer.Layer<AgentBus> = Layer.effect(
    AgentBus,
    Effect.gen(function* () {
      const hub = yield* PubSub.unbounded<AgentBusEnvelope>()

      return AgentBus.of({
        publish: (envelope) => PubSub.publish(hub, envelope).pipe(Effect.asVoid),
        subscribe: (sessionId) => {
          const sid = sessionId !== undefined ? SessionId.make(sessionId) : undefined
          return Stream.fromPubSub(hub).pipe(
            Stream.filter((envelope) => sid === undefined || envelope.sessionId === sid),
            Stream.map((envelope) => envelope.event),
          )
        },
      })
    }),
  )
}

export const AgentBusMemory = AgentBus.memory
