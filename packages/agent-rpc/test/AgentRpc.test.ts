import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import {
  Agent as AgentPackage,
  JournalMemory,
  Module,
  RunEvent,
  Runtime,
  type Agent as AgentModule,
  type Journal as JournalModule,
} from "@roop/agent"
import { JournalFs } from "@roop/journal-fs"
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Ref,
  Schema,
  Stream,
} from "effect"
import { LanguageModel, type Response, Tool } from "effect/unstable/ai"
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

/** The live stream of a one-step text run: its journal events in commit order, plus the delta. */
const textRunTags = [
  "user/message",
  "run",
  "turn",
  "step",
  "model/attempt",
  "model/request",
  "text/delta",
  "model/attempt",
  "step",
  "turn",
  "run",
]

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
  agent: AgentModule.AgentDefinition<never, never> = HostedAgent,
) =>
  RunSupervisorLive(agent).pipe(
    Layer.provide(Layer.mergeAll(Runtime.AgentRuntimeLive, journal, model)),
  )

const rpcHost = (
  model: Layer.Layer<LanguageModel.LanguageModel>,
  agent: AgentModule.AgentDefinition<never, never> = HostedAgent,
) => AgentRpcServer.pipe(Layer.provide(hostLive(model, JournalMemory.JournalMemory, agent)))

const Slow = Tool.make("slow", { parameters: Schema.Struct({}), success: Schema.String })

/**
 * A steerable host: the model calls the slow tool on its first request of a
 * run and answers with text on the next; the tool blocks until released.
 */
const steerable = Effect.gen(function* () {
  const toolStarted = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  const prompts = yield* Ref.make<Array<ReadonlyArray<unknown>>>([])
  const calls = yield* Ref.make(0)
  const model = Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: (options) =>
        Stream.unwrap(
          Effect.gen(function* () {
            yield* Ref.update(prompts, (all) => [...all, options.prompt.content])
            const call = yield* Ref.updateAndGet(calls, (n) => n + 1)
            return Stream.fromIterable<Response.StreamPartEncoded>(
              call === 1
                ? [{ type: "tool-call", id: "c1", name: "slow", params: {} }]
                : [{ type: "text-delta", id: "text", delta: "done" }],
            )
          }),
        ),
    }),
  )
  const agent: AgentModule.AgentDefinition<never, never> = AgentPackage.Agent.make(
    "steerable",
    Module.tool(Slow, () =>
      Deferred.succeed(toolStarted, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as("slow result"),
      ),
    ),
  )
  return { toolStarted, release, prompts, model, agent }
})

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
        textRunTags,
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
    const emitted = yield* Deferred.make<void>()
    const gate = yield* Deferred.make<void>()
    // The model answers, then holds its stream open until the test lets go.
    const model = Layer.effect(
      LanguageModel.LanguageModel,
      LanguageModel.make({
        generateText: () => Effect.succeed([]),
        streamText: () =>
          Stream.make({ type: "text-delta" as const, id: "text", delta: "hello" }).pipe(
            Stream.tap(() => Deferred.succeed(emitted, undefined)),
            Stream.concat(Stream.fromEffectDrain(Deferred.await(gate))),
          ),
      }),
    )
    yield* Effect.gen(function* () {
      const supervisor = yield* RunSupervisor
      const ownerFiber = yield* Stream.runCollect(
        supervisor.start({ sessionId: "rpc-live", prompt: "hello" }),
      ).pipe(Effect.forkChild)
      yield* Deferred.await(emitted)
      const subscriberFiber = yield* Stream.runCollect(supervisor.subscribe("rpc-live")).pipe(
        Effect.forkChild,
      )
      yield* Effect.yieldNow
      yield* Deferred.succeed(gate, undefined)
      const owned = yield* Fiber.join(ownerFiber)
      const subscribed = yield* Fiber.join(subscriberFiber)
      assert.deepStrictEqual(
        [...owned].map((event) => event._tag),
        textRunTags,
      )
      assert.deepStrictEqual(
        [...subscribed].map((event) => event._tag),
        textRunTags,
      )
    }).pipe(Effect.scoped, Effect.provide(hostLive(model)))
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
      textRunTags,
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
      textRunTags,
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

it.effect("the live stream is the journal history interleaved with live-only events", () =>
  Effect.gen(function* () {
    const client = yield* RpcTest.makeClient(AgentRpc)
    const live = yield* Stream.runCollect(
      client.StartRun({ sessionId: "rpc-mirror", prompt: "hello", meta: { title: "Mirror" } }),
    )
    const history = yield* client.GetHistory({ sessionId: "rpc-mirror" })
    const durable = [...live].filter((event) => !RunEvent.isLive(event))
    assert.deepStrictEqual(durable, [...history.events])
    assert.ok([...live].some((event) => event._tag === "text/delta"))
    assert.ok(RunEvent.isTerminal([...live].at(-1)!))
    assert.strictEqual(history.revision, durable.length)
  }).pipe(Effect.scoped, Effect.provide(rpcHost(finiteModel))),
)

it.effect("SendMessage steers the active run, or starts one when none is active", () =>
  Effect.gen(function* () {
    const { toolStarted, release, prompts, model, agent } = yield* steerable
    yield* Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(AgentRpc)

      // No run is active: the message becomes the prompt of a new run.
      const first = yield* client.SendMessage({ sessionId: "steer", content: "go" })
      assert.deepStrictEqual(first, { runId: "steer:0", started: true })
      const subscriber = yield* Effect.forkChild(
        Stream.runCollect(client.SubscribeRun({ sessionId: "steer" })),
      )

      // The run is inside its slow tool: the message joins the same run.
      yield* Deferred.await(toolStarted)
      const second = yield* client.SendMessage({
        sessionId: "steer",
        content: "also update the tests",
      })
      assert.deepStrictEqual(second, { runId: "steer:0", started: false })
      yield* Deferred.succeed(release, undefined)
      const events = yield* Fiber.join(subscriber)
      assert.ok(RunEvent.isTerminal(events.at(-1)!))

      // The journal holds the message after the step's tool result, and the
      // next model request carried it after that result.
      const history = yield* client.GetHistory({ sessionId: "steer" })
      const tags = history.events.map((event) => event._tag)
      const steerIndex = history.events.findIndex(
        (event) => event._tag === "user/message" && event.content === "also update the tests",
      )
      assert.ok(tags.indexOf("tool/result") < steerIndex)
      assert.ok(
        steerIndex < history.events.findIndex((event) => event._tag === "step" && event.step === 2),
      )
      const seen = yield* Ref.get(prompts)
      assert.strictEqual(seen.length, 2)
      const request = JSON.stringify(seen[1])
      assert.ok(request.indexOf("slow result") < request.indexOf("also update the tests"))

      // The run has ended: a later message starts a fresh run, not RunEnded.
      const third = yield* client.SendMessage({ sessionId: "steer", content: "again" })
      assert.deepStrictEqual(third, { runId: `steer:${history.revision}`, started: true })
      yield* Effect.exit(Stream.runDrain(client.SubscribeRun({ sessionId: "steer" })))
      const after = yield* client.GetHistory({ sessionId: "steer" })
      assert.deepStrictEqual(
        after.events.flatMap(
          (event: { readonly _tag: string; readonly runId?: unknown; readonly state?: unknown }) =>
            event._tag === "run" && event.runId === third.runId ? [event.state] : [],
        ),
        ["started", "completed"],
      )
      assert.ok(
        after.events.some((event) => event._tag === "user/message" && event.content === "again"),
      )
    }).pipe(Effect.scoped, Effect.provide(rpcHost(model, agent)))
  }),
)

it.effect("a run started by SendMessage outlives its subscribers", () =>
  Effect.gen(function* () {
    const { toolStarted, release, model, agent } = yield* steerable
    yield* Effect.gen(function* () {
      const supervisor = yield* RunSupervisor
      const started = yield* supervisor.send("detached", "go")
      assert.strictEqual(started.started, true)
      yield* Deferred.await(toolStarted)
      // A subscriber comes and goes while the tool runs; the run is unaffected.
      yield* Stream.runDrain(supervisor.subscribe("detached").pipe(Stream.take(3)))
      yield* Deferred.succeed(release, undefined)
      yield* Stream.runDrain(supervisor.subscribe("detached")).pipe(Effect.ignore)
      const history = yield* supervisor.history("detached")
      assert.ok(
        history.events.some(
          (event: { readonly _tag: string; readonly reason?: unknown }) =>
            event._tag === "run" && event.reason === "completed",
        ),
      )
    }).pipe(Effect.scoped, Effect.provide(hostLive(model, JournalMemory.JournalMemory, agent)))
  }),
)
