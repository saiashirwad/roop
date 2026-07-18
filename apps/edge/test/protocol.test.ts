import { describe, expect, it } from "@effect/vitest"
import { Schema as S } from "effect"

import { PromptError } from "../src/errors.ts"
import * as external from "../src/external.ts"
import { RoomClient } from "../src/RoomClient.ts"

describe("RoomClient protocol schemas", () => {
  it("encodes Prompt payload", () => {
    const encoded = S.encodeSync(external.Prompt.payload)({ text: "hello" })
    expect(encoded).toEqual({ text: "hello" })
  })

  it("decodes Presence event fields", () => {
    const Presence = S.Struct(RoomClient.definition.events.Presence)
    const value = S.decodeUnknownSync(Presence)({
      members: [{ id: "a", name: "alice" }],
    })
    expect(value.members).toEqual([{ id: "a", name: "alice" }])
  })

  it("encodes Say payload", () => {
    const encoded = S.encodeSync(external.Say.payload)({ text: "hi team" })
    expect(encoded).toEqual({ text: "hi team" })
  })

  it("decodes Chat event fields", () => {
    const Chat = S.Struct(RoomClient.definition.events.Chat)
    const value = S.decodeUnknownSync(Chat)({
      id: "c1",
      from: { id: "a", name: "alice" },
      text: "hello",
      at: 1,
    })
    expect(value).toEqual({
      id: "c1",
      from: { id: "a", name: "alice" },
      text: "hello",
      at: 1,
    })
  })

  it("decodes PromptError", () => {
    const err = S.decodeUnknownSync(PromptError)({
      _tag: "PromptError",
      message: "empty",
    })
    expect(err.message).toBe("empty")
  })
})
