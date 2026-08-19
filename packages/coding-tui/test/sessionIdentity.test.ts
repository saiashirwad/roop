import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { ensureSessionId, forkSessionRequest } from "../src/sessionIdentity.ts"

describe("session identity", () => {
  it("allocates an ID for the first prompt and reuses it", () => {
    let allocations = 0
    const allocate = () => {
      allocations += 1
      return "generated-session"
    }
    let sessionId: string | undefined

    sessionId = Effect.runSync(ensureSessionId(sessionId, Effect.sync(allocate)))
    expect(sessionId).toBe("generated-session")

    sessionId = Effect.runSync(ensureSessionId(sessionId, Effect.sync(allocate)))
    expect(sessionId).toBe("generated-session")
    expect(allocations).toBe(1)
  })

  it("does not create a fork request for an unsaved session", () => {
    expect(forkSessionRequest(undefined, undefined)).toBeUndefined()
    expect(forkSessionRequest(undefined, "requested-session")).toBeUndefined()
  })

  it("builds fork requests for persisted sessions", () => {
    expect(forkSessionRequest("current-session", undefined)).toEqual({
      fromSessionId: "current-session",
    })
    expect(forkSessionRequest("current-session", " requested-session ")).toEqual({
      fromSessionId: "current-session",
      toSessionId: "requested-session",
    })
  })
})
