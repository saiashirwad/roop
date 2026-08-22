import { Effect, Layer, Ref } from "effect"

import { makeSessionId, type SessionId } from "./DomainIds.ts"
import type { JournalEvent as JournalEventValue } from "./Event.ts"
import {
  Journal,
  JournalEmptyAppend,
  JournalRevisionConflict,
  type JournalSnapshot,
  type Revision,
  validateJournalEvent,
} from "./Journal.ts"

/** The in-memory provider is the only storage provider owned by the kernel. */
export const JournalMemory = Layer.effect(
  Journal,
  Effect.gen(function* () {
    const sessions = yield* Ref.make(new Map<string, JournalSnapshot>())

    const load = Effect.fn("JournalMemory.load")(function* (sessionId: SessionId | string) {
      const id = sessionId
      const map = yield* Ref.get(sessions)
      const found = map.get(id)
      const snapshot: JournalSnapshot = found ?? {
        sessionId: makeSessionId(id),
        revision: 0,
        events: [],
      }
      return snapshot
    })

    const append = Effect.fn("JournalMemory.append")(function* (
      sessionId: SessionId | string,
      expectedRevision: Revision,
      events: readonly [JournalEventValue, ...JournalEventValue[]],
    ) {
      const sid = makeSessionId(sessionId)
      if (events.length === 0) return yield* new JournalEmptyAppend({ sessionId: sid })
      // Validate every event before changing the map. This keeps a batch atomic.
      yield* Effect.forEach(events, (event) => validateJournalEvent(sid, event), {
        discard: true,
      })
      type AppendResult =
        | { readonly _tag: "conflict"; readonly actualRevision: number }
        | { readonly _tag: "ok"; readonly revision: number }
      const result = yield* Ref.modify(
        sessions,
        (map): readonly [AppendResult, Map<string, JournalSnapshot>] => {
          const id = sid.toString()
          const found = map.get(id)
          const latest: JournalSnapshot = found ?? {
            sessionId: sid,
            revision: 0,
            events: [],
          }
          if (latest.revision !== expectedRevision) {
            return [{ _tag: "conflict" as const, actualRevision: latest.revision }, map]
          }
          const revision = latest.revision + events.length
          return [
            { _tag: "ok" as const, revision },
            new Map(map).set(id, {
              sessionId: sid,
              revision,
              events: [...latest.events, ...events],
            }),
          ]
        },
      )
      if (result._tag === "conflict") {
        return yield* new JournalRevisionConflict({
          sessionId: sid,
          expectedRevision,
          actualRevision: result.actualRevision,
        })
      }
      return result.revision
    })

    return Journal.of({ load, append })
  }),
)

export const JournalMemoryLive = JournalMemory
