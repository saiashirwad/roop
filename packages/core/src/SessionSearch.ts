import { Context, Effect, Layer } from "effect"

import { SessionStore, type SessionSummary } from "./SessionStore.ts"

/** Session discoverability (default: scan store summaries). */
export class SessionSearch extends Context.Service<
  SessionSearch,
  {
    readonly search: (query: string) => Effect.Effect<ReadonlyArray<SessionSummary>>
  }
>()("roop/SessionSearch") {}

export const SessionSearchFromStoreLive = Layer.effect(
  SessionSearch,
  Effect.gen(function* () {
    const store = yield* SessionStore
    return SessionSearch.of({
      search: (query) =>
        Effect.gen(function* () {
          const all = yield* store.list()
          const q = query.trim().toLowerCase()
          if (q.length === 0) {
            return all
          }
          return all.filter(
            (summary) =>
              summary.id.toLowerCase().includes(q) ||
              (summary.title !== undefined && summary.title.toLowerCase().includes(q)),
          )
        }),
    })
  }),
)
