import { assert, it } from "@effect/vitest"
import {
  Agent as AgentPackage,
  DomainIds,
  Journal as JournalPackage,
  JournalMemory as JournalMemoryPackage,
  Middleware,
  Module,
  Runtime,
} from "@roop/agent"
import { Deferred, Effect, Fiber, Layer, Ref, Stream } from "effect"
import { AiError, LanguageModel, Prompt } from "effect/unstable/ai"

import { ApprovalService, approval } from "../../../examples/extensions/approval.ts"
import { contextPruning } from "../../../examples/extensions/contextPruning.ts"
import { doomLoop } from "../../../examples/extensions/doomLoop.ts"
import { modelFallback } from "../../../examples/extensions/modelFallback.ts"
import { subagent } from "../../../examples/extensions/subagent.ts"
import { toolPruning } from "../../../examples/extensions/toolPruning.ts"
const { Agent } = AgentPackage
const { Journal } = JournalPackage
const { JournalMemory } = JournalMemoryPackage
const { AgentRuntimeLive, runAgent } = Runtime

it.effect("approval denial is model-visible and does not call the handler", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0)
    let modelCalls = 0
    const model = yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () => {
        modelCalls += 1
        return modelCalls === 1
          ? Stream.make({
              type: "tool-call" as const,
              id: "deny",
              name: "delegate",
              params: { task: "x" },
            })
          : Stream.make({ type: "text-delta" as const, id: "done", delta: "denied" })
      },
    })
    const module = subagent(Agent.make("unused", Module.empty), "unused-child")
    const events = yield* runAgent(Agent.make("approval", module), {
      sessionId: "approval",
      prompt: "delegate",
      middleware: approval,
    }).pipe(
      Stream.runCollect,
      Effect.provide(
        Layer.mergeAll(
          JournalMemory,
          AgentRuntimeLive,
          Layer.succeed(LanguageModel.LanguageModel, model),
          Layer.succeed(ApprovalService, {
            approve: () => Ref.update(calls, (n) => n + 1).pipe(Effect.as(false)),
          }),
        ),
      ),
    )
    assert.strictEqual(yield* Ref.get(calls), 1)
    assert.ok(events.some((event) => event._tag === "ToolResult" && event.isFailure))
  }),
)

it.effect("loop guard and pruning compose in declaration order", () =>
  Effect.gen(function* () {
    const guard = yield* doomLoop(2)
    const stack = Middleware.all(
      toolPruning((prompt) => prompt),
      guard,
    )
    const output = yield* stack
      .model((input) => Stream.make(input.attempt))({
        sessionId: "extensions",
        turn: 1,
        step: 1,
        prompt: Prompt.empty,
        attempt: 1,
        planId: "plan",
        planFingerprint: "plan",
        toolNames: [],
      })
      .pipe(Stream.runCollect)
    assert.deepStrictEqual([...output], [1])
  }),
)

it.effect("public fallback and context pruning wrap a model request", () =>
  Effect.gen(function* () {
    const fallback = yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () =>
        Stream.make({ type: "text-delta" as const, id: "fallback", delta: "fallback" }),
    })
    const stack = Middleware.all(
      contextPruning(() => Prompt.make("pruned")),
      modelFallback(fallback),
    )
    const seen: string[] = []
    const output = yield* stack
      .model((input) => {
        seen.push(JSON.stringify(input.prompt))
        return input.model === fallback ? Stream.make("fallback") : Stream.fail("primary")
      })({
        sessionId: "public-extensions",
        turn: 1,
        step: 1,
        prompt: Prompt.make("original"),
        attempt: 1,
        planId: "plan",
        planFingerprint: "plan",
        toolNames: [],
      })
      .pipe(Stream.runCollect)

    assert.deepStrictEqual([...output], ["fallback"])
    assert.strictEqual(seen.length, 2)
    assert.ok(seen.every((prompt) => prompt.includes("pruned")))
  }),
)

it.effect("subagent uses a stable independent journal session", () =>
  Effect.gen(function* () {
    const model = yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () => Stream.make({ type: "text-delta" as const, id: "child", delta: "done" }),
    })
    const snapshot = yield* Effect.gen(function* () {
      const built = yield* subagent(Agent.make("child", Module.empty), "child-stable").build({
        sessionId: DomainIds.SessionId.make("parent"),
        runId: DomainIds.RunId.make("parent-run"),
        turn: 1,
        step: 1,
        history: Prompt.empty,
      })
      const finalized = yield* built.tools.finalize
      const result = yield* finalized.toolkit.handle("delegate", { task: "work" })
      yield* Stream.runDrain(result)
      return yield* (yield* Journal).load("child-stable")
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          JournalMemory,
          AgentRuntimeLive,
          Layer.succeed(LanguageModel.LanguageModel, model),
        ),
      ),
    )
    assert.ok(snapshot.events.some((event) => event._tag === "run"))
  }),
)

it.effect("subagent returns child failures as a declared tool failure", () =>
  Effect.gen(function* () {
    const model = yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () =>
        Stream.fail(
          AiError.make({
            module: "extensions-test",
            method: "streamText",
            reason: new AiError.UnknownError({ description: "child failed" }),
          }),
        ),
    })
    const result = yield* Effect.gen(function* () {
      const built = yield* subagent(
        Agent.make("child-failure", Module.empty),
        "child-failure",
      ).build({
        sessionId: DomainIds.SessionId.make("parent"),
        runId: DomainIds.RunId.make("parent-run"),
        turn: 1,
        step: 1,
        history: Prompt.empty,
      })
      const finalized = yield* built.tools.finalize
      const stream = yield* finalized.toolkit.handle("delegate", { task: "fail" })
      return yield* Stream.runCollect(stream)
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          JournalMemory,
          AgentRuntimeLive,
          Layer.succeed(LanguageModel.LanguageModel, model),
        ),
      ),
    )
    assert.ok([...result].some((part) => part.isFailure))
  }),
)

it.effect("interrupting a subagent tool interrupts the child model", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    let calls = 0
    const model = yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () => {
        calls += 1
        return calls === 1
          ? Stream.make({
              type: "tool-call" as const,
              id: "delegate-cancel",
              name: "delegate",
              params: { task: "wait" },
            })
          : Stream.fromEffect(Deferred.succeed(started, undefined)).pipe(
              Stream.drain,
              Stream.concat(Stream.never),
            )
      },
    })
    const parent = Agent.make(
      "parent-cancel",
      subagent(Agent.make("child-cancel", Module.empty), "child-cancel"),
    )
    const snapshot = yield* Effect.gen(function* () {
      const fiber = yield* runAgent(parent, {
        sessionId: "parent-cancel",
        prompt: "delegate",
      }).pipe(Stream.runDrain, Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      return yield* (yield* Journal).load("child-cancel")
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          JournalMemory,
          AgentRuntimeLive,
          Layer.succeed(LanguageModel.LanguageModel, model),
        ),
      ),
    )
    assert.ok(
      snapshot.events.some(
        (event) =>
          event._tag === "run" &&
          event.runId.startsWith("child-cancel") &&
          event.state === "aborted",
      ),
    )
  }),
)
