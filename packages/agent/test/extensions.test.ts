import { assert, it } from "@effect/vitest"
import {
  Agent as AgentPackage,
  Journal as JournalPackage,
  JournalMemory as JournalMemoryPackage,
  Middleware,
  Module,
  Runtime,
} from "@roop/agent"
import { Effect, Layer, Ref, Stream } from "effect"
import { LanguageModel, Prompt } from "effect/unstable/ai"

import { ApprovalService, approval } from "../../../examples/extensions/approval.ts"
import { doomLoop } from "../../../examples/extensions/doomLoop.ts"
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
      })
      .pipe(Stream.runCollect)
    assert.deepStrictEqual([...output], [1])
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
        sessionId: "parent",
        runId: "parent-run",
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
