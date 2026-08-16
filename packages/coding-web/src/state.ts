import { AgentRpc } from "@roop/agent-rpc/AgentRpc.ts"
import { AgentRpcClientHttp } from "@roop/agent-rpc/AgentRpcHttp.ts"
import { apply, type Item, fromSessionEvents } from "@roop/agent-rpc/Transcript.ts"
import { cryptoWeb } from "@roop/agent/cryptoWeb.ts"
import { Context, Crypto, Effect, Layer, Stream } from "effect"
import { Atom } from "effect/unstable/reactivity"
import { RpcClient } from "effect/unstable/rpc"

export type { Item }

const crypto = Context.get(Effect.runSync(Effect.scoped(Layer.build(cryptoWeb))), Crypto.Crypto)

export const nextSessionId = (): string => Effect.runSync(Effect.orDie(crypto.randomUUIDv4))

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
    ctx.set(transcriptAtom, fromSessionEvents(session.events))
  }),
)

export const forkSessionAtom = runtime.fn((toSessionId: string | undefined, ctx: Atom.FnContext) =>
  Effect.gen(function* () {
    const client = yield* RpcClient.make(AgentRpc)
    const current = ctx(sessionAtom)
    const result =
      toSessionId === undefined || toSessionId === ""
        ? yield* client.ForkSession({ fromSessionId: current })
        : yield* client.ForkSession({ fromSessionId: current, toSessionId })
    const session = yield* client.GetHistory({ sessionId: result.id })
    ctx.set(sessionAtom, result.id)
    ctx.set(transcriptAtom, fromSessionEvents(session.events))
    ctx.refresh(sessionsAtom)
  }),
)

export const interruptAtom = runtime.fn((_: void, ctx: Atom.FnContext) =>
  Effect.gen(function* () {
    const client = yield* RpcClient.make(AgentRpc)
    yield* client.Interrupt({ sessionId: ctx(sessionAtom) }).pipe(Effect.ignore)
  }),
)
