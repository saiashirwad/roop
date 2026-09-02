import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import {
  Agent as AgentPackage,
  JournalMemory,
  Module,
  Runtime,
  type Agent as AgentModule,
  type Journal as JournalModule,
} from "@roop/agent"
import { JournalFs } from "@roop/journal-fs"
import { Effect, Exit, Fiber, FileSystem, Layer, Option, Ref, Stream } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import { RpcClient } from "effect/unstable/rpc"
import * as RpcTest from "effect/unstable/rpc/RpcTest"

import { AgentRpc } from "../src/AgentRpc.ts"
import { AgentRpcClientHttp, AgentRpcServerHttp } from "../src/AgentRpcHttp.ts"
import { AgentRpcServer } from "../src/AgentRpcServer.ts"
import { RunSupervisor, RunSupervisorLive } from "../src/RunSupervisor.ts"

const HostedAgent: AgentModule.AgentDefinition<never, never> = AgentPackage.Agent.make(
  "rpc-test",
  Module.empty,
)

const modelLayer = (started: Ref.Ref<boolean>, hold = false) =>
  Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () => {
        const output = Stream.fromIterable([
          { type: "text-delta" as const, id: "text", delta: "hello" },
        ]).pipe(Stream.tap(() => Ref.set(started, true)))
        return hold ? Stream.concat(output, Stream.never) : output
      },
    }),
  )

const live = (started: Ref.Ref<boolean>, hold = false) =>
  RunSupervisorLive(HostedAgent).pipe(
    Layer.provide(
      Layer.mergeAll(
        Runtime.AgentRuntimeLive,
        JournalMemory.JournalMemory,
        modelLayer(started, hold),
      ),
    ),
  )

const hostLive = (
  model: Layer.Layer<LanguageModel.LanguageModel>,
  journal: Layer.Layer<JournalModule.Journal> = JournalMemory.JournalMemory,
) =>
  RunSupervisorLive(HostedAgent).pipe(
    Layer.provide(Layer.mergeAll(Runtime.AgentRuntimeLive, journal, model)),
  )

const rpcHost = (model: Layer.Layer<LanguageModel.LanguageModel>) =>
  AgentRpcServer.pipe(Layer.provide(hostLive(model)))

const finiteModel = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: () => Effect.succeed([]),
    streamText: () => Stream.make({ type: "text-delta" as const, id: "text", delta: "hello" }),
  }),
)

const holdingModel = (finalized: Ref.Ref<number>) =>
  Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () =>
        Stream.concat(
          Stream.make({ type: "text-delta" as const, id: "text", delta: "hello" }),
          Stream.never,
        ).pipe(Stream.ensuring(Ref.update(finalized, (count) => count + 1))),
    }),
  )

it.effect("starts a direct hosted run and reads durable history", () =>
  Effect.gen(function* () {
    const started = yield* Ref.make(false)
    yield* Effect.gen(function* () {
      const supervisor = yield* RunSupervisor
      const events = yield* Stream.runCollect(
        supervisor.start({ sessionId: "rpc-history", prompt: "hello" }),
      )
      assert.deepStrictEqual(
        [...events].map((event) => event._tag),
        ["TextDelta", "Finish"],
      )
      assert.strictEqual(yield* Ref.get(started), true)
      const history = yield* supervisor.history("rpc-history")
      assert.ok(
        history.events.some(
          (event: { readonly _tag: string; readonly state?: unknown }) =>
            event._tag === "run" && event.state === "completed",
        ),
      )
    }).pipe(Effect.scoped, Effect.provide(live(started)))
  }),
)

it.effect("registers an active subscriber with no replay/live gap", () =>
  Effect.gen(function* () {
    const started = yield* Ref.make(false)
    yield* Effect.gen(function* () {
      const supervisor = yield* RunSupervisor
      const ownerFiber = yield* Stream.runCollect(
        supervisor.start({ sessionId: "rpc-live", prompt: "hello" }),
      ).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      const subscribed = yield* Stream.runCollect(supervisor.subscribe("rpc-live"))
      yield* Fiber.join(ownerFiber)
      assert.deepStrictEqual(
        [...subscribed].map((event) => event._tag),
        ["TextDelta", "Finish"],
      )
      assert.strictEqual(yield* Ref.get(started), true)
    }).pipe(Effect.scoped, Effect.provide(live(started)))
  }),
)

it.effect("interrupts an active run owned by the supervisor", () =>
  Effect.gen(function* () {
    const started = yield* Ref.make(false)
    yield* Effect.gen(function* () {
      const supervisor = yield* RunSupervisor
      const ownerFiber = yield* Stream.runDrain(
        supervisor.start({ sessionId: "rpc-interrupt", prompt: "wait" }),
      ).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Effect.yieldNow
      yield* supervisor.interrupt("rpc-interrupt")
      yield* Fiber.join(ownerFiber).pipe(Effect.ignore)
    }).pipe(Effect.scoped, Effect.provide(live(started, true)))
  }),
)

it.effect("round-trips every RPC operation and encodes typed errors", () =>
  Effect.gen(function* () {
    const client = yield* RpcTest.makeClient(AgentRpc)
    const events = yield* Stream.runCollect(
      client.StartRun({ sessionId: "rpc-memory", prompt: "hello" }),
    )
    assert.deepStrictEqual(
      [...events].map((event) => event._tag),
      ["TextDelta", "Finish"],
    )

    const history = yield* client.GetHistory({ sessionId: "rpc-memory" })
    assert.ok(history.events.some((event) => event._tag === "run"))

    const sessions = yield* client.ListSessions()
    assert.deepStrictEqual(
      sessions.map((session) => [String(session.sessionId), session.revision, session.title]),
      [["rpc-memory", history.revision, Option.none()]],
    )
    yield* client.DeleteSession({ sessionId: "rpc-memory" })
    assert.deepStrictEqual(yield* client.ListSessions(), [])

    const missingSubscription = yield* Effect.exit(
      Stream.runDrain(client.SubscribeRun({ sessionId: "missing" })),
    )
    assert.ok(Exit.isFailure(missingSubscription))
    assert.strictEqual(
      Option.getOrThrow(Exit.findErrorOption(missingSubscription))._tag,
      "RunNotFound",
    )

    const missingInterrupt = yield* Effect.exit(client.InterruptRun({ sessionId: "missing" }))
    assert.ok(Exit.isFailure(missingInterrupt))
    assert.strictEqual(
      Option.getOrThrow(Exit.findErrorOption(missingInterrupt))._tag,
      "RunNotFound",
    )
  }).pipe(Effect.scoped, Effect.provide(rpcHost(finiteModel))),
)

it.effect("round-trips an RPC stream over HTTP NDJSON", () =>
  Effect.gen(function* () {
    const serverLayer = AgentRpcServerHttp("/rpc").pipe(Layer.provide(hostLive(finiteModel)))
    const { handler, dispose } = HttpRouter.toWebHandler(serverLayer, { disableLogger: true })
    yield* Effect.addFinalizer(() => Effect.promise(() => dispose()))
    /* SAFETY: web fetch test harness converts standard fetch arguments to web handler input */
    const fetchWithHandler: typeof fetch = (input, init) =>
      (handler as any)(input instanceof Request ? input : new Request(input, init))
    const clientLayer = AgentRpcClientHttp("http://localhost/rpc").pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchWithHandler)),
    )
    const client = yield* RpcClient.make(AgentRpc).pipe(Effect.provide(clientLayer))
    const events = yield* Stream.runCollect(
      client.StartRun({ sessionId: "rpc-http", prompt: "hello" }),
    )
    assert.deepStrictEqual(
      [...events].map((event) => event._tag),
      ["TextDelta", "Finish"],
    )
    const history = yield* client.GetHistory({ sessionId: "rpc-http" })
    assert.ok(history.events.length > 0)
  }).pipe(Effect.scoped),
)

it.effect("HTTP stream disconnect interrupts the owned model producer", () =>
  Effect.gen(function* () {
    const finalized = yield* Ref.make(0)
    const serverLayer = AgentRpcServerHttp("/rpc").pipe(
      Layer.provide(hostLive(holdingModel(finalized))),
    )
    const { handler, dispose } = HttpRouter.toWebHandler(serverLayer, { disableLogger: true })
    yield* Effect.addFinalizer(() => Effect.promise(() => dispose()))
    /* SAFETY: web fetch test harness converts standard fetch arguments to web handler input */
    const fetchWithHandler: typeof fetch = (input, init) =>
      (handler as any)(input instanceof Request ? input : new Request(input, init))
    const clientLayer = AgentRpcClientHttp("http://localhost/rpc").pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchWithHandler)),
    )
    const client = yield* RpcClient.make(AgentRpc).pipe(Effect.provide(clientLayer))
    yield* Effect.exit(
      Stream.runDrain(
        client.StartRun({ sessionId: "rpc-disconnect", prompt: "hold" }).pipe(Stream.take(1)),
      ),
    )
    yield* Effect.yieldNow
    yield* Effect.yieldNow
    assert.strictEqual(yield* Ref.get(finalized), 1)
    const interrupt = yield* Effect.exit(client.InterruptRun({ sessionId: "rpc-disconnect" }))
    assert.ok(Exit.isFailure(interrupt))
    assert.strictEqual(Option.getOrThrow(Exit.findErrorOption(interrupt))._tag, "RunNotFound")
  }).pipe(Effect.scoped),
)

it.effect("keeps sessions across a server restart with the file-system journal", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "roop-rpc-" })
    const journal = JournalFs.layer({ directory }).pipe(
      Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
    )
    const server = () => AgentRpcServer.pipe(Layer.provide(hostLive(finiteModel, journal)))

    const firstRevision = yield* Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(AgentRpc)
      yield* Stream.runDrain(
        client.StartRun({
          sessionId: "durable",
          prompt: "hello",
          meta: { title: "Durable session", cwd: "/repo" },
        }),
      )
      return (yield* client.GetHistory({ sessionId: "durable" })).revision
    }).pipe(Effect.scoped, Effect.provide(server()))

    yield* Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(AgentRpc)
      const sessions = yield* client.ListSessions()
      assert.deepStrictEqual(
        sessions.map((session) => [
          String(session.sessionId),
          session.revision,
          session.title,
          session.cwd,
        ]),
        [["durable", firstRevision, Option.some("Durable session"), Option.some("/repo")]],
      )
      const history = yield* client.GetHistory({ sessionId: "durable" })
      assert.strictEqual(history.revision, firstRevision)
      assert.deepStrictEqual(
        history.events.slice(0, 2).map((event) => event._tag),
        ["session/meta", "user/message"],
      )
      yield* client.DeleteSession({ sessionId: "durable" })
      assert.deepStrictEqual(yield* client.ListSessions(), [])
    }).pipe(Effect.scoped, Effect.provide(server()))
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)),
)
