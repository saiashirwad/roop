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
