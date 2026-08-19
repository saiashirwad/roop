import { Effect } from "effect"

export const ensureSessionId = <E, R>(
  sessionId: string | undefined,
  allocate: Effect.Effect<string, E, R>,
): Effect.Effect<string, E, R> => (sessionId === undefined ? allocate : Effect.succeed(sessionId))

export const forkSessionRequest = (
  sessionId: string | undefined,
  requestedId: string | undefined,
): { readonly fromSessionId: string; readonly toSessionId?: string } | undefined => {
  if (sessionId === undefined) return undefined
  const toSessionId = requestedId?.trim()
  return toSessionId === undefined || toSessionId === ""
    ? { fromSessionId: sessionId }
    : { fromSessionId: sessionId, toSessionId }
}
