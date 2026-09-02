import { assert, it } from "@effect/vitest"
import { Agent, JournalMemory, Module, Runtime, type Agent as AgentModule } from "@roop/agent"
import { Effect, Exit, Fiber, Layer, Option, Schema, Stream } from "effect"
import { LanguageModel } from "effect/unstable/ai"

import { RunNotFound, RunSupervisor, RunSupervisorLive } from "../src/RunSupervisor.ts"

const agent: AgentModule.AgentDefinition<never, never> = Agent.Agent.make(
  "supervisor-test",
  Module.empty,
)
const model = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: () => Effect.succeed([]),
    streamText: () => Stream.empty,
  }),
)
const layer = RunSupervisorLive(agent).pipe(
  Layer.provide(Layer.mergeAll(Runtime.AgentRuntimeLive, JournalMemory.JournalMemory, model)),
)

const holdingModel = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: () => Effect.succeed([]),
    streamText: () => Stream.never,
  }),
)
const holdingLayer = RunSupervisorLive(agent).pipe(
  Layer.provide(
    Layer.mergeAll(Runtime.AgentRuntimeLive, JournalMemory.JournalMemory, holdingModel),
  ),
)

it.effect("reports a deterministic not-found error for inactive runs", () =>
  Effect.gen(function* () {
    const supervisor = yield* RunSupervisor
    const exit = yield* Effect.exit(supervisor.interrupt("missing"))
    assert.ok(Exit.isFailure(exit))
    const error = Option.getOrThrow(Exit.findErrorOption(exit))
    assert.strictEqual(error._tag, "RunNotFound")
    assert.strictEqual(error.sessionId, "missing")
    assert.strictEqual(error.message, "Active run for session 'missing' was not found")
    assert.ok(Schema.is(RunNotFound)(error))
  }).pipe(Effect.scoped, Effect.provide(layer)),
)

it.effect("rejects a second owner stream with SessionBusy", () =>
  Effect.gen(function* () {
    const supervisor = yield* RunSupervisor
    const owner = yield* Stream.runDrain(
      supervisor.start({ sessionId: "busy", prompt: "hold" }),
    ).pipe(Effect.forkChild)
    yield* Effect.yieldNow
    const second = yield* Effect.exit(
      Stream.runDrain(supervisor.start({ sessionId: "busy", prompt: "hold again" })),
    )
    assert.ok(Exit.isFailure(second))
    const error = Option.getOrThrow(Exit.findErrorOption(second))
    assert.strictEqual(error._tag, "SessionBusy")
    assert.strictEqual(error.message, "Session 'busy' is busy")
    yield* Fiber.interrupt(owner)
  }).pipe(Effect.scoped, Effect.provide(holdingLayer)),
)

it.effect("rejects a subscription when no run is active", () =>
  Effect.gen(function* () {
    const supervisor = yield* RunSupervisor
    const exit = yield* Effect.exit(Stream.runDrain(supervisor.subscribe("missing")))
    assert.ok(Exit.isFailure(exit))
    const error = Option.getOrThrow(Exit.findErrorOption(exit))
    assert.strictEqual(error._tag, "RunNotFound")
    assert.strictEqual(error.message, "Active run for session 'missing' was not found")
  }).pipe(Effect.scoped, Effect.provide(layer)),
)

it.effect("lists sessions with run metadata and deletes idle ones", () =>
  Effect.gen(function* () {
    const supervisor = yield* RunSupervisor
    yield* Stream.runDrain(
      supervisor.start({ sessionId: "listed", prompt: "hello", meta: { title: "Listed run" } }),
    )
    const listed = yield* supervisor.list
    assert.deepStrictEqual(
      listed.map((session) => [String(session.sessionId), session.title, session.cwd]),
      [["listed", Option.some("Listed run"), Option.none()]],
    )
    assert.ok(listed[0]!.revision > 0)
    yield* supervisor.delete("listed")
    yield* supervisor.delete("listed")
    assert.deepStrictEqual(yield* supervisor.list, [])
    assert.strictEqual((yield* supervisor.history("listed")).revision, 0)
  }).pipe(Effect.scoped, Effect.provide(layer)),
)

it.effect("releases a session whose owner is interrupted before the producer starts", () =>
  Effect.gen(function* () {
    const supervisor = yield* RunSupervisor
    const owner = yield* Stream.runDrain(
      supervisor.start({ sessionId: "early-interrupt", prompt: "hold" }),
    ).pipe(Effect.forkChild)
    yield* Effect.yieldNow
    yield* Fiber.interrupt(owner)
    const exit = yield* Effect.exit(supervisor.interrupt("early-interrupt"))
    assert.ok(Exit.isFailure(exit))
    assert.strictEqual(Option.getOrThrow(Exit.findErrorOption(exit))._tag, "RunNotFound")
  }).pipe(Effect.scoped, Effect.provide(holdingLayer)),
)

it.effect("refuses to delete a session with an active run", () =>
  Effect.gen(function* () {
    const supervisor = yield* RunSupervisor
    const owner = yield* Stream.runDrain(
      supervisor.start({ sessionId: "busy-delete", prompt: "hold" }),
    ).pipe(Effect.forkChild)
    yield* Effect.yieldNow
    const exit = yield* Effect.exit(supervisor.delete("busy-delete"))
    assert.ok(Exit.isFailure(exit))
    assert.strictEqual(Option.getOrThrow(Exit.findErrorOption(exit))._tag, "SessionBusy")
    yield* Fiber.interrupt(owner)
    yield* supervisor.delete("busy-delete")
    assert.deepStrictEqual(yield* supervisor.list, [])
  }).pipe(Effect.scoped, Effect.provide(holdingLayer)),
)
