import { AgentRpc } from "@roop/agent-rpc/AgentRpc.ts"
import { AgentRpcClientHttp } from "@roop/agent-rpc/AgentRpcHttp.ts"
import type { AgentEvent } from "@roop/agent/AgentEvent.ts"
import { deriveMessages } from "@roop/agent/SessionEvent.ts"
import { Effect, Stream } from "effect"
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

const fromMessages = (
  messages: ReadonlyArray<{ readonly role: string; readonly content: unknown }>,
): ReadonlyArray<Item> => {
  let items: ReadonlyArray<Item> = []
  for (const message of messages) {
    if (message.role === "system" || typeof message.content === "string") continue
    /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
    for (const part of message.content as ReadonlyArray<Record<string, unknown>>) {
      switch (part["type"]) {
        case "text": {
          /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
          const text = part["text"] as string
          items =
            message.role === "user"
              ? [...items, { kind: "user", text }]
              : [...items, { kind: "assistant", text }]
          break
        }
        case "tool-call": {
          items = [
            ...items,
            {
              kind: "tool",
              /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
              id: part["id"] as string,
              /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
              name: part["name"] as string,
              params: part["params"],
            },
          ]
          break
        }
        case "tool-result": {
          items = items.map((item) =>
            item.kind === "tool" && item.id === part["id"]
              /* SAFETY: The typed integration boundary establishes the asserted runtime contract. */
              ? { ...item, result: part["result"], isFailure: part["isFailure"] as boolean }
              : item,
          )
          break
        }
      }
    }
  }
  return items
}

const runtime = Atom.runtime(AgentRpcClientHttp("/rpc"))

export const transcriptAtom = Atom.make<ReadonlyArray<Item>>([])
export const sessionAtom = Atom.make<string>(crypto.randomUUID())
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
    yield* client
      .Prompt({
        prompt: text,
        sessionId: ctx(sessionAtom),
        ...(modelId === undefined ? {} : { modelId }),
        maxTurns: 50,
      })
      .pipe(
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
