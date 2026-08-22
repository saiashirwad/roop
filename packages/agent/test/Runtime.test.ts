/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this test uses pinned Effect AI encoded fixtures and audit-event fixture narrowing. */

import { assert, it } from "@effect/vitest"
import { Effect, Exit, Ref, Schema, Stream } from "effect"
import { AiError, LanguageModel, Tool } from "effect/unstable/ai"
import type * as Response from "effect/unstable/ai/Response"

import { Agent } from "../src/Agent.ts"
import type { SessionEvent } from "../src/AgentEvents.ts"
import { canRetryAttempt, type LogicalModelRequest } from "../src/internal/effectAiAdapter.ts"
import { Module } from "../src/Module.ts"
import { runAgent } from "../src/Runtime.ts"

const Inspect = Tool.make("inspect", {
  parameters: Schema.Struct({ id: Schema.String }),
  success: Schema.String,
})
const Commit = Tool.make("commit", {
  parameters: Schema.Struct({ id: Schema.String }),
  success: Schema.String,
})
const DomainFailureTool = Tool.make("domain_failure", {
  parameters: Schema.Struct({ id: Schema.String }),
  success: Schema.String,
  failure: Schema.Struct({ reason: Schema.String }),
  failureMode: "return",
})
const InfrastructureTool = Tool.make("infrastructure_failure", {
  parameters: Schema.Struct({ id: Schema.String }),
  success: Schema.String,
})
const LocalTool = Tool.make("local_tool", {
  parameters: Schema.Struct({ id: Schema.String }),
  success: Schema.Struct({ source: Schema.String }),
})
const ProviderTool = Tool.make("provider_tool", {
  parameters: Schema.Struct({ id: Schema.String }),
  success: Schema.Struct({ source: Schema.String }),
})

it.effect("renders one dynamic plan before each logical model request", () =>
  Effect.gen(function* () {
    const renders = yield* Ref.make(0)
    const journal = yield* Ref.make<Array<SessionEvent>>([])
    const modelPrompts = yield* Ref.make<ReadonlyArray<unknown[]>>([])
    const inspect = Module.tool(Inspect, () => Effect.succeed("inspected"), "inspect")
    const commit = Module.tool(Commit, () => Effect.succeed("committed"), "commit")
    const dynamicAgent = Agent.make("dynamic", (context) =>
      Effect.gen(function* () {
        yield* Ref.update(renders, (count) => count + 1)
        return yield* (context.step === 1 ? inspect : commit).build(context)
      }),
    )

    let modelCalls = 0
    const model = yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: (options: { readonly prompt: { readonly content: ReadonlyArray<unknown> } }) => {
        modelCalls += 1
        return Stream.fromIterable(
          modelCalls === 1
            ? [
                {
                  type: "tool-call" as const,
                  id: "inspect-call",
                  name: "inspect",
                  params: { id: "42" },
                },
              ]
            : modelCalls === 2
              ? [
                  {
                    type: "tool-call" as const,
                    id: "commit-call",
                    name: "commit",
                    params: { id: "42" },
                  },
                ]
              : [{ type: "text-delta" as const, id: "done", delta: "done" }],
        ).pipe(
          Stream.tap(() =>
            Ref.update(modelPrompts, (all) => [...all, [...options.prompt.content]]),
          ),
          // SAFETY: the scripted provider emits only the encoded response parts
          // declared in this test.
          /* oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the scripted provider emits only the encoded response parts declared in this test. */
        ) as Stream.Stream<Response.StreamPartEncoded, never, never>
      },
    })

    const events = yield* runAgent(dynamicAgent, {
      sessionId: "dynamic-session",
      prompt: "inspect then commit",
      append: (event) => Ref.update(journal, (all) => [...all, event]),
      policy: { maxTurns: 1, maxStepsPerTurn: 3, maxTotalSteps: 3 },
    }).pipe(Stream.runCollect, Effect.provideService(LanguageModel.LanguageModel, model))

    assert.strictEqual(yield* Ref.get(renders), 3)
    assert.ok(events.some((event) => event._tag === "Finish" && event.reason === "completed"))
    assert.ok(events.some((event) => event._tag === "ToolCall" && event.name === "inspect"))
    assert.ok(events.some((event) => event._tag === "ToolResult" && event.name === "inspect"))
    const requests = (yield* Ref.get(journal)).filter(
      (event): event is Extract<SessionEvent, { _tag: "model/request" }> =>
        event._tag === "model/request",
    )
    assert.deepStrictEqual(
      // SAFETY: every request here is produced by the explicit runtime audit
      // path, which records `toolNames` on the model/request event.
      /* SAFETY: explicit runtime audit events always contain toolNames. */
      requests.map((event) => (event.request as { toolNames: ReadonlyArray<string> }).toolNames),
      [["inspect"], ["commit"], ["commit"]],
    )
    assert.strictEqual(
      // SAFETY: the same runtime audit contract records a string fingerprint.
      /* SAFETY: explicit runtime audit events always contain fingerprint. */
      new Set(requests.map((event) => (event.request as { fingerprint: string }).fingerprint)).size,
      3,
    )
    const prompts = yield* Ref.get(modelPrompts)
    assert.strictEqual(prompts.length, 3)
    assert.ok(JSON.stringify(prompts[1]).includes("inspect-call"))
    assert.ok(JSON.stringify(prompts[1]).includes("inspected"))
    assert.ok(events.some((event) => event._tag === "ToolCall" && event.name === "commit"))
    assert.ok(events.some((event) => event._tag === "ToolResult" && event.name === "commit"))
  }),
)

const modelFailure = () =>
  AiError.make({
    module: "runtime-test",
    method: "streamText",
    reason: new AiError.UnknownError({ description: "model failed" }),
  })

it.effect("retries before output with the same logical plan", () =>
  Effect.gen(function* () {
    const renders = yield* Ref.make(0)
    const requests = yield* Ref.make<Array<unknown>>([])
    const attempts: Array<Pick<LogicalModelRequest, "planId" | "fingerprint">> = []
    let calls = 0
    const agent = Agent.make("retry", (context) =>
      Effect.gen(function* () {
        yield* Ref.update(renders, (count) => count + 1)
        return yield* Module.instructions(`step ${context.step}`).build(context)
      }),
    )
    const model = yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () => {
        calls += 1
        return calls === 1
          ? Stream.fail(modelFailure())
          : Stream.make({ type: "text-delta" as const, id: "done", delta: "ok" })
      },
    })
    const append = (event: SessionEvent) =>
      event._tag === "model/request"
        ? Ref.update(requests, (all) => [...all, event.request])
        : Effect.void
    const events = yield* runAgent(agent, {
      sessionId: "retry-session",
      prompt: "retry",
      append,
      attemptPolicy: {
        maxAttempts: 2,
        shouldRetry: (_error, state) => canRetryAttempt(state),
        onAttempt: (logical) => {
          attempts.push({ planId: logical.planId, fingerprint: logical.fingerprint })
        },
      },
    }).pipe(Stream.runCollect, Effect.provideService(LanguageModel.LanguageModel, model))

    assert.strictEqual(calls, 2)
    assert.strictEqual(yield* Ref.get(renders), 1)
    assert.strictEqual((yield* Ref.get(requests)).length, 1)
    assert.strictEqual(attempts.length, 2)
    assert.deepStrictEqual(attempts[0], attempts[1])
    assert.ok(events.some((event) => event._tag === "TextDelta" && event.delta === "ok"))
  }),
)

it.effect("does not retry after model output starts", () =>
  Effect.gen(function* () {
    let calls = 0
    const agent = Agent.make("no-duplicate", Module.instructions("answer"))
    const model = yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () => {
        calls += 1
        return Stream.make({ type: "text-delta" as const, id: "partial", delta: "part" }).pipe(
          Stream.concat(Stream.fail(modelFailure())),
        )
      },
    })
    const exit = yield* Effect.exit(
      runAgent(agent, {
        sessionId: "no-duplicate-session",
        prompt: "answer",
        attemptPolicy: { maxAttempts: 2 },
      }).pipe(Stream.runCollect, Effect.provideService(LanguageModel.LanguageModel, model)),
    )
    assert.ok(Exit.isFailure(exit))
    assert.strictEqual(calls, 1)
  }),
)

it.effect("keeps direct model failures typed", () =>
  Effect.gen(function* () {
    const model = yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () => Stream.fail(modelFailure()),
    })
    const exit = yield* Effect.exit(
      runAgent(Agent.make("typed-error", Module.empty), {
        sessionId: "typed-error-session",
        prompt: "fail",
      }).pipe(Stream.runCollect, Effect.provideService(LanguageModel.LanguageModel, model)),
    )
    assert.ok(Exit.isFailure(exit))
    if (Exit.isFailure(exit)) {
      const error = Exit.findErrorOption(exit)
      assert.ok(error._tag === "Some")
      if (error._tag === "Some") assert.ok(Schema.is(AiError.AiError)(error.value))
    }
  }),
)

it.effect("keeps unknown tool decoding failures typed", () =>
  Effect.gen(function* () {
    const model = yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () =>
        Stream.make({
          type: "tool-call" as const,
          id: "unknown-call",
          name: "not_declared",
          params: {},
        }),
    })
    const exit = yield* Effect.exit(
      runAgent(Agent.make("unknown-tool", Module.empty), {
        sessionId: "unknown-tool-session",
        prompt: "unknown",
      }).pipe(Stream.runCollect, Effect.provideService(LanguageModel.LanguageModel, model)),
    )
    assert.ok(Exit.isFailure(exit))
    if (Exit.isFailure(exit)) {
      const error = Exit.findErrorOption(exit)
      assert.ok(error._tag === "Some")
      if (error._tag === "Some") assert.ok(Schema.is(AiError.AiError)(error.value))
    }
  }),
)

it.effect("returns declared domain failures to the model and continues", () =>
  Effect.gen(function* () {
    let calls = 0
    const agent = Agent.make(
      "domain-failure",
      Module.tool(DomainFailureTool, () => Effect.fail({ reason: "declared failure" })),
    )
    const model = yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () => {
        calls += 1
        return Stream.fromIterable(
          calls === 1
            ? [
                {
                  type: "tool-call" as const,
                  id: "domain-call",
                  name: "domain_failure",
                  params: { id: "42" },
                },
              ]
            : [{ type: "text-delta" as const, id: "done", delta: "continued" }],
        )
      },
    })
    const events = yield* runAgent(agent, {
      sessionId: "domain-failure-session",
      prompt: "try domain",
    }).pipe(Stream.runCollect, Effect.provideService(LanguageModel.LanguageModel, model))
    assert.strictEqual(calls, 2)
    assert.ok(
      events.some(
        (event) =>
          event._tag === "ToolResult" && event.name === "domain_failure" && event.isFailure,
      ),
    )
    assert.ok(events.some((event) => event._tag === "TextDelta" && event.delta === "continued"))
  }),
)

it.effect("keeps infrastructure tool failures in the stream error channel", () =>
  Effect.gen(function* () {
    const agent = Agent.make(
      "infrastructure-failure",
      Module.tool(InfrastructureTool, () => Effect.fail("transport unavailable")),
    )
    const model = yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () =>
        Stream.make({
          type: "tool-call" as const,
          id: "infra-call",
          name: "infrastructure_failure",
          params: { id: "42" },
        }),
    })
    const exit = yield* Effect.exit(
      runAgent(agent, {
        sessionId: "infrastructure-failure-session",
        prompt: "try infrastructure",
      }).pipe(Stream.runCollect, Effect.provideService(LanguageModel.LanguageModel, model)),
    )
    assert.ok(Exit.isFailure(exit))
  }),
)

it.effect("keeps one durable pair for local and provider-executed calls", () =>
  Effect.gen(function* () {
    const agent = Agent.make(
      "mixed-tools",
      Module.all(
        Module.tool(LocalTool, ({ id }) => Effect.succeed({ source: `local:${id}` })),
        Module.tool(ProviderTool, () => Effect.succeed({ source: "unused" })),
      ),
    )
    let modelCalls = 0
    const model = yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () => {
        modelCalls += 1
        if (modelCalls > 1) {
          return Stream.make({ type: "text-delta" as const, id: "done", delta: "complete" })
        }
        return Stream.fromIterable([
          {
            type: "tool-call" as const,
            id: "local-call",
            name: "local_tool",
            params: { id: "42" },
          },
          {
            type: "tool-call" as const,
            id: "provider-call",
            name: "provider_tool",
            params: { id: "42" },
            providerExecuted: true,
          },
          {
            type: "tool-result" as const,
            id: "provider-call",
            name: "provider_tool",
            isFailure: false,
            result: { source: "provider" },
            providerExecuted: true,
          },
        ]).pipe(
          Stream.concat(
            Stream.make({ type: "text-delta" as const, id: "done", delta: "complete" }),
          ),
        )
      },
    })
    const journal = yield* Ref.make<Array<SessionEvent>>([])
    const events = yield* runAgent(agent, {
      sessionId: "mixed-tools-session",
      prompt: "run both",
      append: (event) => Ref.update(journal, (all) => [...all, event]),
    }).pipe(Stream.runCollect, Effect.provideService(LanguageModel.LanguageModel, model))
    const stored = yield* Ref.get(journal)
    const calls = stored.filter((event) => event._tag === "tool/call")
    const results = stored.filter((event) => event._tag === "tool/result")
    assert.strictEqual(calls.length, 2)
    assert.strictEqual(results.length, 2)
    assert.deepStrictEqual(calls.map((call) => call.id).sort(), ["local-call", "provider-call"])
    assert.deepStrictEqual(results.map((result) => result.id).sort(), [
      "local-call",
      "provider-call",
    ])
    assert.ok(events.some((event) => event._tag === "Finish" && event.reason === "completed"))
  }),
)
