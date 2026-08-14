import { AgentRpc } from "@roop/agent-rpc/AgentRpc.ts"
import { AgentRpcClientHttp } from "@roop/agent-rpc/AgentRpcHttp.ts"
import type { AgentEvent } from "@roop/agent/AgentEvent.ts"
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
  }
}

const runtime = Atom.runtime(AgentRpcClientHttp("/rpc"))

export const transcriptAtom = Atom.make<ReadonlyArray<Item>>([])
export const sessionAtom = Atom.make(crypto.randomUUID())
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
      )
  }),
)

export const interruptAtom = runtime.fn((_: void, ctx: Atom.FnContext) =>
  Effect.gen(function* () {
    const client = yield* RpcClient.make(AgentRpc)
    yield* client.Interrupt({ sessionId: ctx(sessionAtom) }).pipe(Effect.ignore)
  }),
)
