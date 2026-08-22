import { Effect, Layer, Ref } from "effect"

import type { JournalEvent as JournalEventValue } from "./Event.ts"
import {
  Journal,
  JournalEmptyAppend,
  JournalRevisionConflict,
  type JournalAppendError,
  type JournalLoadError,
  type JournalSnapshot,
  type Revision,
  validateJournalEvent,
} from "./Journal.ts"

/** The in-memory provider is the only storage provider owned by the kernel. */
export const JournalMemory = Layer.effect(
  Journal,
  Effect.gen(function* () {
    const sessions = yield* Ref.make(new Map<string, JournalSnapshot>())

    const load = (sessionId: string): Effect.Effect<JournalSnapshot, JournalLoadError> =>
      Ref.get(sessions).pipe(
        Effect.map(
          (map) =>
            map.get(sessionId) ?? {
              sessionId,
              revision: 0,
              events: [],
            },
        ),
      )

    const append = (
      sessionId: string,
      expectedRevision: Revision,
      events: readonly [JournalEventValue, ...JournalEventValue[]],
    ): Effect.Effect<Revision, JournalAppendError> =>
      Effect.gen(function* () {
        if (events.length === 0) return yield* new JournalEmptyAppend({ sessionId })
        // Validate every event before changing the map. This keeps a batch atomic.
        yield* Effect.forEach(events, (event) => validateJournalEvent(sessionId, event), {
          discard: true,
        })
        type AppendResult =
          | { readonly _tag: "conflict"; readonly actualRevision: number }
          | { readonly _tag: "ok"; readonly revision: number }
        const result = yield* Ref.modify(
          sessions,
          (map): readonly [AppendResult, Map<string, JournalSnapshot>] => {
            const latest = map.get(sessionId) ?? { sessionId, revision: 0, events: [] }
            if (latest.revision !== expectedRevision) {
              return [{ _tag: "conflict" as const, actualRevision: latest.revision }, map]
            }
            const revision = latest.revision + events.length
            return [
              { _tag: "ok" as const, revision },
              new Map(map).set(sessionId, {
                sessionId,
                revision,
                events: [...latest.events, ...events],
              }),
            ]
          },
        )
        if (result._tag === "conflict") {
          return yield* new JournalRevisionConflict({
            sessionId,
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
