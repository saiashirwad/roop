import { AgentRpc } from "@roop/agent-rpc/AgentRpc.ts"
import { AgentRpcClientHttp } from "@roop/agent-rpc/AgentRpcHttp.ts"
import type { AgentEvent } from "@roop/agent/AgentEvent.ts"
import { deriveMessages } from "@roop/agent/SessionEvent.ts"
import { Crypto, Effect, Stream } from "effect"
import { Atom } from "effect/unstable/reactivity"
import { RpcClient } from "effect/unstable/rpc"

export type Item =
  | { readonly kind: "user"; readonly text: string }
  | { readonly kind: "assistant"; readonly text: string }
  | {
      readonly kind: "tool"
      readonly id: string
      readonly name: string
      readonly params: unknown
      readonly result?: unknown
      readonly isFailure?: boolean
      readonly children?: ReadonlyArray<Item>
    }
  | { readonly kind: "notice"; readonly text: string }

const apply = (items: ReadonlyArray<Item>, event: AgentEvent): ReadonlyArray<Item> => {
  switch (event._tag) {
    case "TextDelta": {
      const last = items.at(-1)
      return last?.kind === "assistant"
        ? [...items.slice(0, -1), { kind: "assistant", text: last.text + event.delta }]
        : [...items, { kind: "assistant", text: event.delta }]
    }
    case "ReasoningDelta": {
      return items
    }
    case "ToolCall": {
      return [...items, { kind: "tool", id: event.id, name: event.name, params: event.params }]
    }
    case "ToolResult": {
      return items.map((item) =>
        item.kind === "tool" && item.id === event.id
          ? { ...item, result: event.result, isFailure: event.isFailure }
          : item,
      )
    }
    case "Finish": {
      return event.reason === "completed"
        ? items
        : [
            ...items,
            {
              kind: "notice",
              text: `${event.reason}${event.message === undefined ? "" : `: ${event.message}`}`,
            },
          ]
    }
    case "Subagent": {
      let done = false
      return items
        .slice()
        .reverse()
        .map((item) =>
          !done && item.kind === "tool" && item.name === event.name && item.result === undefined
            ? ((done = true), { ...item, children: apply(item.children ?? [], event.event) })
            : item,
        )
        .reverse()
    }
  }
}

const fromMessages = (messages: ReturnType<typeof deriveMessages>): ReadonlyArray<Item> => {
  let items: ReadonlyArray<Item> = []
  for (const message of messages) {
    switch (message.role) {
      case "system":
        break
      case "user": {
        for (const part of message.content) {
          if (part.type === "text") {
            items = [...items, { kind: "user", text: part.text }]
          }
        }
        break
      }
      case "assistant": {
        for (const part of message.content) {
          if (part.type === "text") {
            items = [...items, { kind: "assistant", text: part.text }]
          } else if (part.type === "tool-call") {
            items = [...items, { kind: "tool", id: part.id, name: part.name, params: part.params }]
          }
        }
        break
      }
      case "tool": {
        for (const part of message.content) {
          if (part.type === "tool-result") {
            items = items.map((item) =>
              item.kind === "tool" && item.id === part.id
                ? { ...item, result: part.result, isFailure: part.isFailure }
                : item,
            )
          }
        }
        break
      }
    }
  }
  return items
}

const sessionCrypto = Crypto.make({
  randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) =>
    Effect.promise(() =>
      globalThis.crypto.subtle
        .digest(algorithm, new Uint8Array(data))
        .then((bytes) => new Uint8Array(bytes)),
    ),
})

export const nextSessionId = (): string => Effect.runSync(Effect.orDie(sessionCrypto.randomUUIDv4))

const runtime = Atom.runtime(AgentRpcClientHttp("/rpc"))

export const transcriptAtom = Atom.make<ReadonlyArray<Item>>([])
export const sessionAtom = Atom.make<string>(nextSessionId())
export const modelAtom = Atom.make<string | undefined>(undefined)

export const capsAtom = runtime.atom(
  Effect.gen(function* () {
    const client = yield* RpcClient.make(AgentRpc)
    return yield* client.Capabilities()
  }),
)

export const promptAtom = runtime.fn((text: string, ctx: Atom.FnContext) =>
  Effect.gen(function* () {
    const client = yield* RpcClient.make(AgentRpc)
    ctx.set(transcriptAtom, [...ctx(transcriptAtom), { kind: "user", text }])
    const modelId = ctx(modelAtom)
    const payload = {
      prompt: text,
      sessionId: ctx(sessionAtom),
      maxTurns: 50,
    }
    yield* client.Prompt(modelId === undefined ? payload : { ...payload, modelId }).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => ctx.set(transcriptAtom, apply(ctx(transcriptAtom), event))),
      ),
      Effect.catch((error) =>
        Effect.sync(() =>
          ctx.set(transcriptAtom, [
            ...ctx(transcriptAtom),
            { kind: "notice", text: String(error) },
          ]),
        ),
      ),
      Effect.ensuring(Effect.sync(() => ctx.refresh(sessionsAtom))),
    )
  }),
)

export const sessionsAtom = runtime.atom(
  Effect.gen(function* () {
    const client = yield* RpcClient.make(AgentRpc)
    return yield* client.ListSessions()
  }),
)

export const selectSessionAtom = runtime.fn((sessionId: string, ctx: Atom.FnContext) =>
  Effect.gen(function* () {
    const client = yield* RpcClient.make(AgentRpc)
    const session = yield* client.GetHistory({ sessionId })
    ctx.set(sessionAtom, sessionId)
    ctx.set(transcriptAtom, fromMessages(deriveMessages(session.events)))
  }),
)

export const interruptAtom = runtime.fn((_: void, ctx: Atom.FnContext) =>
  Effect.gen(function* () {
    const client = yield* RpcClient.make(AgentRpc)
    yield* client.Interrupt({ sessionId: ctx(sessionAtom) }).pipe(Effect.ignore)
  }),
)
