import { assert, it } from "@effect/vitest"
import { Deferred, Effect, Fiber, Layer, Option, Ref, Schema, Stream } from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai"

import type { AgentEvent } from "../src/AgentEvent.ts"
import {
  AgentNotFound,
  AgentRegistry,
  AgentRunner,
  AgentRunnerLive,
  RunNotFound,
  SpawnDepthExceeded,
  SpawnLimitExceeded,
  type StreamToolkit,
} from "../src/AgentRunner.ts"
import { SessionHubLive } from "../src/SessionHub.ts"
import { SessionLog, SessionLogLive } from "../src/SessionLog.ts"
import { SessionStoreMemoryLive } from "../src/SessionStore.ts"

const Ping = Tool.make("ping", {
  description: "ping",
  parameters: Schema.Struct({}),
  success: Schema.Struct({ ok: Schema.Boolean }),
})

const PingToolkit = Toolkit.make(Ping)
const PingHandlers = PingToolkit.toLayer({
  ping: () => Effect.succeed({ ok: true }),
})

const BaseLog = SessionLogLive.pipe(
  Layer.provide(SessionStoreMemoryLive),
  Layer.provide(SessionHubLive),
)

const RunnerOnly = AgentRunnerLive.pipe(
  Layer.provideMerge(BaseLog),
  Layer.provideMerge(PingHandlers),
)

const makeTextModel = (deltas: ReadonlyArray<string>) =>
  LanguageModel.make({
    generateText: () => Effect.succeed([]),
    streamText: () =>
      Stream.fromIterable(
        deltas.map((delta, index) => ({
          type: "text-delta" as const,
          id: `text-${index}`,
          delta,
        })),
      ),
  })

const makeScriptedModel = (turns: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>) =>
  Effect.gen(function* () {
    const index = yield* Ref.make(0)
    return yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () =>
        Stream.unwrap(
          Effect.gen(function* () {
            const i = yield* Ref.getAndUpdate(index, (n) => n + 1)
            const parts = turns[i] ?? turns[turns.length - 1] ?? []
            return Stream.fromIterable(parts as never)
          }),
        ),
    })
  })

const makeGatedModel = (gate: Deferred.Deferred<void>, delta: string) =>
  LanguageModel.make({
    generateText: () => Effect.succeed([]),
    streamText: () =>
      Stream.unwrap(
        Effect.gen(function* () {
          yield* Deferred.await(gate)
          return Stream.make({
            type: "text-delta" as const,
            id: "gated",
            delta,
          })
        }),
      ),
  })

const collectRun = (
  runner: AgentRunner["Service"],
  options: Parameters<AgentRunner["Service"]["runOnSession"]>[0],
) => Stream.runCollect(runner.runOnSession(options)).pipe(Effect.map((chunk) => [...chunk]))

const tags = (events: ReadonlyArray<AgentEvent>) => events.map((event) => event._tag)

it.layer(RunnerOnly)("AgentRunner loop", (it) => {
  it.effect("text-only run emits started → deltas → completed and persists", () =>
    Effect.gen(function* () {
      const runner = yield* AgentRunner
      const log = yield* SessionLog
      const session = yield* log.create({ kind: "main" })
      const model = yield* makeTextModel(["Hello", " world"])
      const interrupt = yield* Deferred.make<void>()
      const toolkit = (yield* PingToolkit) as unknown as StreamToolkit
      const runId = "run-text"

      const events = yield* collectRun(runner, {
        model,
        toolkit,
        sessionId: session.id,
        history: [],
        prompt: "say hi",
        runId,
        interrupt,
        systemPrompt: "system",
      })

      assert.deepStrictEqual(tags(events), ["RunStarted", "TextDelta", "TextDelta", "RunCompleted"])
      assert.strictEqual(
        events
          .filter((e) => e._tag === "TextDelta")
          .map((e) => (e._tag === "TextDelta" ? e.delta : ""))
          .join(""),
        "Hello world",
      )

      const stored = yield* log.get(session.id)
      assert.ok(stored.records.some((r) => r.entry._tag === "UserPrompt"))
      assert.ok(
        stored.records.some(
          (r) => r.entry._tag === "Agent" && r.entry.event._tag === "RunCompleted",
        ),
      )
    }),
  )

  it.effect("tool turn then final text completes multi-step loop", () =>
    Effect.gen(function* () {
      const runner = yield* AgentRunner
      const log = yield* SessionLog
      const session = yield* log.create({ kind: "main" })
      const toolkit = (yield* PingToolkit) as unknown as StreamToolkit
      const model = yield* makeScriptedModel([
        [
          {
            type: "tool-call",
            id: "call-ping",
            name: "ping",
            params: {},
          },
        ],
        [{ type: "text-delta", id: "t1", delta: "pong" }],
      ])
      const interrupt = yield* Deferred.make<void>()

      const events = yield* collectRun(runner, {
        model,
        toolkit,
        sessionId: session.id,
        history: [],
        prompt: "ping then answer",
        runId: "run-tools",
        interrupt,
        systemPrompt: "system",
      })

      assert.ok(tags(events).includes("ToolCall"), `missing ToolCall: ${tags(events).join(",")}`)
      assert.ok(
        tags(events).includes("ToolResult"),
        `missing ToolResult: ${tags(events).join(",")}`,
      )
      assert.ok(tags(events).includes("TextDelta"), `missing TextDelta: ${tags(events).join(",")}`)
      assert.strictEqual(tags(events).at(-1), "RunCompleted")

      const toolResult = events.find((e) => e._tag === "ToolResult")
      assert.ok(toolResult?._tag === "ToolResult")
      if (toolResult?._tag === "ToolResult") {
        assert.strictEqual(toolResult.isFailure, false)
      }
    }),
  )

  it.effect("maxTurns stops after N model turns", () =>
    Effect.gen(function* () {
      const runner = yield* AgentRunner
      const log = yield* SessionLog
      const session = yield* log.create({ kind: "main" })
      const toolkit = (yield* PingToolkit) as unknown as StreamToolkit
      const model = yield* LanguageModel.make({
        generateText: () => Effect.succeed([]),
        streamText: () =>
          Stream.make({
            type: "tool-call" as const,
            id: crypto.randomUUID(),
            name: "ping",
            params: {},
          }),
      })
      const interrupt = yield* Deferred.make<void>()

      const events = yield* collectRun(runner, {
        model,
        toolkit,
        sessionId: session.id,
        history: [],
        prompt: "loop",
        runId: "run-max",
        interrupt,
        systemPrompt: "system",
        maxTurns: 2,
      })

      assert.strictEqual(tags(events).at(-1), "RunFailed")
      const failed = events.find((e) => e._tag === "RunFailed")
      assert.ok(failed?._tag === "RunFailed")
      if (failed?._tag === "RunFailed") {
        assert.ok(failed.message.includes("maxTurns"), `unexpected fail message: ${failed.message}`)
      }
      assert.strictEqual(events.filter((e) => e._tag === "ToolCall").length, 2)
    }),
  )

  it.effect("interrupt mid-run emits RunInterrupted and is cascade-ready", () =>
    Effect.gen(function* () {
      const runner = yield* AgentRunner
      const log = yield* SessionLog
      const session = yield* log.create({ kind: "main" })
      const toolkit = (yield* PingToolkit) as unknown as StreamToolkit
      const gate = yield* Deferred.make<void>()

      const model = yield* LanguageModel.make({
        generateText: () => Effect.succeed([]),
        streamText: () =>
          Stream.unwrap(
            Effect.gen(function* () {
              yield* Deferred.await(gate)
              return Stream.make({
                type: "text-delta" as const,
                id: "late",
                delta: "should not finish",
              })
            }),
          ),
      })

      const interrupt = yield* Deferred.make<void>()
      const runId = "run-interrupt"
      yield* runner.registerRun(runId, interrupt)

      const fiber = yield* Effect.forkChild(
        collectRun(runner, {
          model,
          toolkit,
          sessionId: session.id,
          history: [],
          prompt: "hang",
          runId,
          interrupt,
          systemPrompt: "system",
        }),
      )

      yield* Effect.yieldNow
      yield* Effect.yieldNow

      yield* runner.interrupt(runId)
      const events = yield* Fiber.join(fiber)

      assert.ok(tags(events).includes("RunInterrupted"))
      assert.ok(!tags(events).includes("RunCompleted"))
      assert.ok(!tags(events).includes("TextDelta"))

      const missing = yield* runner.interrupt(runId).pipe(Effect.flip)
      assert.instanceOf(missing, RunNotFound)
    }),
  )

  it.effect("registerRun is merge-safe (keeps children)", () =>
    Effect.gen(function* () {
      const runner = yield* AgentRunner
      const parentInterrupt = yield* Deferred.make<void>()
      const childInterrupt = yield* Deferred.make<void>()
      const parentId = "parent-merge"
      const childId = "child-merge"

      yield* runner.registerRun(parentId, parentInterrupt)
      yield* runner.registerRun(childId, childInterrupt, parentId)
      yield* runner.registerRun(parentId, parentInterrupt)

      yield* runner.interrupt(parentId)

      assert.strictEqual(yield* Deferred.isDone(parentInterrupt), true)
      assert.strictEqual(yield* Deferred.isDone(childInterrupt), true)
    }),
  )

  it.effect("clearRun interrupts orphan children", () =>
    Effect.gen(function* () {
      const runner = yield* AgentRunner
      const parentInterrupt = yield* Deferred.make<void>()
      const childInterrupt = yield* Deferred.make<void>()
      const parentId = "parent-clear"
      const childId = "child-clear"

      yield* runner.registerRun(parentId, parentInterrupt)
      yield* runner.registerRun(childId, childInterrupt, parentId)

      yield* runner.clearRun(parentId)

      assert.strictEqual(yield* Deferred.isDone(childInterrupt), true)
    }),
  )
})

const WorkerToolkit = Toolkit.make(Ping)
const WorkerHandlers = WorkerToolkit.toLayer({
  ping: () => Effect.succeed({ ok: true }),
})

const RegistryLive = Layer.effect(
  AgentRegistry,
  Effect.gen(function* () {
    const toolkit = yield* WorkerToolkit
    return AgentRegistry.of({
      list: () => [
        {
          id: "worker",
          description: "test worker",
          tools: [{ name: "ping", description: "ping" }],
        },
      ],
      resolve: (agentId) =>
        agentId === "worker"
          ? Effect.succeed({
              id: "worker",
              description: "test worker",
              systemPrompt: "worker system",
              toolkit: toolkit as unknown as StreamToolkit,
              maxTurns: 4,
            })
          : Effect.fail(new AgentNotFound({ agentId })),
    })
  }),
).pipe(Layer.provide(WorkerHandlers))

const RunnerWithRegistry = AgentRunnerLive.pipe(
  Layer.provideMerge(BaseLog),
  Layer.provideMerge(RegistryLive),
)

it.layer(RunnerWithRegistry)("AgentRunner spawnAgent", (it) => {
  it.effect("unknown agent fails with AgentNotFound", () =>
    Effect.gen(function* () {
      const runner = yield* AgentRunner
      const model = yield* makeTextModel(["x"])
      const result = yield* runner
        .spawn({
          agentId: "nope",
          task: "t",
          parentToolCallId: "tc",
          model,
          parentSessionId: "s",
          parentRunId: "r",
        })
        .pipe(Effect.flip)
      assert.instanceOf(result, AgentNotFound)
      assert.strictEqual(result.agentId, "nope")
    }),
  )

  it.effect("spawns child session, runs loop, returns summary", () =>
    Effect.gen(function* () {
      const runner = yield* AgentRunner
      const log = yield* SessionLog
      const parent = yield* log.create({ kind: "main" })
      const parentRunId = "parent-spawn"
      const parentInterrupt = yield* Deferred.make<void>()
      yield* runner.registerRun(parentRunId, parentInterrupt)

      const model = yield* makeTextModel(["explored fine"])
      let progressSession: string | undefined

      const result = yield* runner
        .spawn({
          agentId: "worker",
          task: "look around",
          parentToolCallId: "tool-1",
          model,
          parentSessionId: parent.id,
          parentRunId,
          reportProgress: (p) =>
            Effect.sync(() => {
              progressSession = p.childSessionId
            }),
        })
        .pipe(Effect.flatMap((handle) => handle.await))

      assert.strictEqual(result.status, "completed")
      assert.ok(result.summary.includes("explored fine"))
      assert.strictEqual(progressSession, result.childSessionId)

      const child = yield* log.get(result.childSessionId)
      assert.strictEqual(child.kind, "subagent")
      assert.strictEqual(child.parentSessionId, parent.id)
      assert.strictEqual(child.agentId, "worker")

      const parentSession = yield* log.get(parent.id)
      const parentTags = parentSession.records
        .filter((r) => r.entry._tag === "Agent")
        .map((r) => (r.entry._tag === "Agent" ? r.entry.event._tag : ""))
      assert.ok(parentTags.includes("SubagentStarted"))
      assert.ok(parentTags.includes("SubagentCompleted"))
    }),
  )

  it.effect("parent interrupt cascades into running child", () =>
    Effect.gen(function* () {
      const runner = yield* AgentRunner
      const log = yield* SessionLog
      const parent = yield* log.create({ kind: "main" })
      const parentRunId = "parent-cascade"
      const parentInterrupt = yield* Deferred.make<void>()
      yield* runner.registerRun(parentRunId, parentInterrupt)

      const hang = yield* Deferred.make<void>()
      const model = yield* LanguageModel.make({
        generateText: () => Effect.succeed([]),
        streamText: () =>
          Stream.unwrap(
            Effect.gen(function* () {
              yield* Deferred.await(hang)
              return Stream.make({
                type: "text-delta" as const,
                id: "x",
                delta: "never",
              })
            }),
          ),
      })

      const fiber = yield* Effect.forkChild(
        runner
          .spawn({
            agentId: "worker",
            task: "hang forever",
            parentToolCallId: "tool-hang",
            model,
            parentSessionId: parent.id,
            parentRunId,
          })
          .pipe(Effect.flatMap((handle) => handle.await)),
      )

      yield* Effect.yieldNow
      yield* Effect.yieldNow
      yield* Effect.yieldNow

      yield* runner.interrupt(parentRunId)
      const result = yield* Fiber.join(fiber)

      assert.strictEqual(result.status, "interrupted")
      assert.strictEqual(result.summary, "Subagent interrupted")
    }),
  )

  it.effect("spawn returns a live handle before the child completes", () =>
    Effect.gen(function* () {
      const runner = yield* AgentRunner
      const log = yield* SessionLog
      const parent = yield* log.create({ kind: "main" })
      const parentRunId = "parent-bg"
      const parentInterrupt = yield* Deferred.make<void>()
      yield* runner.registerRun(parentRunId, parentInterrupt)

      const gate = yield* Deferred.make<void>()
      const model = yield* makeGatedModel(gate, "done later")

      const handle = yield* runner.spawn({
        agentId: "worker",
        task: "work in background",
        parentToolCallId: "tool-bg",
        model,
        parentSessionId: parent.id,
        parentRunId,
      })

      assert.strictEqual(handle.agentId, "worker")
      const live = yield* runner.getRun(handle.runId)
      assert.ok(Option.isSome(live))

      yield* Deferred.succeed(gate, undefined)
      const result = yield* handle.await

      assert.strictEqual(result.status, "completed")
      assert.ok(result.summary.includes("done later"))
      assert.strictEqual(result.childSessionId, handle.sessionId)
      assert.strictEqual(result.childRunId, handle.runId)
    }),
  )

  it.effect("handle.interrupt settles await with status interrupted", () =>
    Effect.gen(function* () {
      const runner = yield* AgentRunner
      const log = yield* SessionLog
      const parent = yield* log.create({ kind: "main" })
      const parentRunId = "parent-handle-stop"
      const parentInterrupt = yield* Deferred.make<void>()
      yield* runner.registerRun(parentRunId, parentInterrupt)

      const gate = yield* Deferred.make<void>()
      const model = yield* makeGatedModel(gate, "never")

      const handle = yield* runner.spawn({
        agentId: "worker",
        task: "hang until interrupted",
        parentToolCallId: "tool-handle-stop",
        model,
        parentSessionId: parent.id,
        parentRunId,
      })

      yield* Effect.yieldNow
      yield* Effect.yieldNow
      yield* Effect.yieldNow

      yield* handle.interrupt
      const result = yield* handle.await

      assert.strictEqual(result.status, "interrupted")
      assert.strictEqual(result.summary, "Subagent interrupted")
      yield* handle.interrupt
    }),
  )

  it.effect("getRun returns none for unknown run ids", () =>
    Effect.gen(function* () {
      const runner = yield* AgentRunner
      const missing = yield* runner.getRun("no-such-run")
      assert.ok(Option.isNone(missing))
    }),
  )

  it.effect("clearRun on the parent settles a pending background child's await", () =>
    Effect.gen(function* () {
      const runner = yield* AgentRunner
      const log = yield* SessionLog
      const parent = yield* log.create({ kind: "main" })
      const parentRunId = "parent-orphan"
      yield* runner.registerRun(parentRunId, yield* Deferred.make<void>())

      const gate = yield* Deferred.make<void>()
      const handle = yield* runner.spawn({
        agentId: "worker",
        task: "background work",
        parentToolCallId: "tool-orphan",
        model: yield* makeGatedModel(gate, "never"),
        parentSessionId: parent.id,
        parentRunId,
      })

      yield* Effect.yieldNow
      yield* Effect.yieldNow
      yield* Effect.yieldNow

      yield* runner.clearRun(parentRunId)

      const result = yield* handle.await
      assert.strictEqual(result.status, "interrupted")
    }),
  )

  it.effect("spawn at depth 3 fails with SpawnDepthExceeded", () =>
    Effect.gen(function* () {
      const runner = yield* AgentRunner
      const model = yield* makeTextModel(["x"])
      const error = yield* runner
        .spawn({
          agentId: "worker",
          task: "too deep",
          parentToolCallId: "tool-deep",
          model,
          parentSessionId: "s",
          parentRunId: "r",
          depth: 3,
        })
        .pipe(Effect.flip)
      assert.instanceOf(error, SpawnDepthExceeded)
      assert.ok(error instanceof SpawnDepthExceeded && error.depth === 3 && error.max === 3)
    }),
  )

  it.effect("spawn fails with SpawnLimitExceeded past 8 live children", () =>
    Effect.gen(function* () {
      const runner = yield* AgentRunner
      const parentRunId = "parent-full"
      yield* runner.registerRun(parentRunId, yield* Deferred.make<void>())
      for (let i = 0; i < 8; i++) {
        yield* runner.registerRun(`child-full-${i}`, yield* Deferred.make<void>(), parentRunId)
      }

      const model = yield* makeTextModel(["x"])
      const error = yield* runner
        .spawn({
          agentId: "worker",
          task: "one too many",
          parentToolCallId: "tool-full",
          model,
          parentSessionId: "s",
          parentRunId,
        })
        .pipe(Effect.flip)
      assert.instanceOf(error, SpawnLimitExceeded)
      assert.ok(error instanceof SpawnLimitExceeded && error.count === 8 && error.max === 8)
    }),
  )

  it.effect("spawn with sessionId resumes the child session with its history", () =>
    Effect.gen(function* () {
      const runner = yield* AgentRunner
      const log = yield* SessionLog
      const parent = yield* log.create({ kind: "main" })
      const parentRunId = "parent-resume"
      const parentInterrupt = yield* Deferred.make<void>()
      yield* runner.registerRun(parentRunId, parentInterrupt)

      const first = yield* runner
        .spawn({
          agentId: "worker",
          task: "first pass",
          parentToolCallId: "tool-resume-1",
          model: yield* makeTextModel(["first answer"]),
          parentSessionId: parent.id,
          parentRunId,
        })
        .pipe(Effect.flatMap((handle) => handle.await))
      assert.strictEqual(first.status, "completed")
      const before = (yield* log.get(first.childSessionId)).records.length

      const handle = yield* runner.spawn({
        agentId: "worker",
        task: "second pass",
        parentToolCallId: "tool-resume-2",
        model: yield* makeTextModel(["second answer"]),
        parentSessionId: parent.id,
        parentRunId,
        sessionId: first.childSessionId,
      })
      assert.strictEqual(handle.sessionId, first.childSessionId)

      const result = yield* handle.await
      assert.strictEqual(result.status, "completed")
      assert.strictEqual(result.childSessionId, first.childSessionId)
      assert.ok(result.summary.includes("second answer"))

      const after = yield* log.get(first.childSessionId)
      assert.ok(after.records.length > before, "resume must append to the same session")
    }),
  )
})
