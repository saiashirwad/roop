/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: this test uses pinned Effect AI encoded fixtures and audit-event fixture narrowing. */

import { assert, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Layer, Ref, Schema, Stream } from "effect"
import { AiError, LanguageModel, Prompt, Tool } from "effect/unstable/ai"
import type * as Response from "effect/unstable/ai/Response"

import { Agent } from "../src/Agent.ts"
import { SessionId } from "../src/DomainIds.ts"
import { FinalizationError, UnsafeModelRetry } from "../src/Error.ts"
import { EVENT_VERSION, type JournalEvent } from "../src/Event.ts"
import { Journal, JournalError } from "../src/Journal.ts"
import { JournalMemory } from "../src/JournalMemory.ts"
import * as Middleware from "../src/Middleware.ts"
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

    const { events, stored } = yield* Effect.gen(function* () {
      const events = yield* runAgent(dynamicAgent, {
        sessionId: "dynamic-session",
        prompt: "inspect then commit",
        policy: { maxTurns: 1, maxStepsPerTurn: 3, maxTotalSteps: 3 },
      }).pipe(Stream.runCollect)
      const journal = yield* Journal
      return { events, stored: yield* journal.load("dynamic-session") }
    }).pipe(
      Effect.provide(JournalMemory),
      Effect.provideService(LanguageModel.LanguageModel, model),
    )

    assert.strictEqual(yield* Ref.get(renders), 3)
    assert.ok(events.some((event) => event._tag === "Finish" && event.reason === "completed"))
    assert.ok(events.some((event) => event._tag === "ToolCall" && event.name === "inspect"))
    assert.ok(events.some((event) => event._tag === "ToolResult" && event.name === "inspect"))
    const requests = stored.events.filter((event) => event._tag === "model/request")
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

it.effect("writes a versioned run and attempt lifecycle in deterministic order", () =>
  Effect.gen(function* () {
    const model = yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () => Stream.make({ type: "text-delta" as const, id: "done", delta: "done" }),
    })
    const program = Effect.gen(function* () {
      const journal = yield* Journal
      yield* runAgent(Agent.make("lifecycle", Module.empty), {
        sessionId: "lifecycle-session",
        prompt: "hello",
      }).pipe(Stream.runDrain)
      const session = yield* journal.load("lifecycle-session")
      return session.events
    })
    const events = yield* program.pipe(
      Effect.provide(JournalMemory),
      Effect.provideService(LanguageModel.LanguageModel, model),
    )
    assert.ok(events.every((event) => event.version === EVENT_VERSION))
    assert.deepStrictEqual(
      events.map((event) => event._tag),
      [
        "user/message",
        "run",
        "turn",
        "step",
        "model/attempt",
        "model/request",
        "model/attempt",
        "step",
        "turn",
        "run",
      ],
    )
  }),
)

it.effect("recovers an unresolved tool call before new work without executing it", () =>
  Effect.gen(function* () {
    const executed = yield* Ref.make(0)
    const tool = Tool.make("danger", {
      parameters: Schema.Struct({ id: Schema.String }),
      success: Schema.String,
    })
    const agent = Agent.make(
      "recovery",
      Module.tool(tool, () => Ref.update(executed, (count) => count + 1).pipe(Effect.as("done"))),
    )
    const model = yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () => Stream.make({ type: "text-delta" as const, id: "done", delta: "ok" }),
    })
    const program = Effect.gen(function* () {
      const journal = yield* Journal
      const open: JournalEvent[] = [
        { _tag: "user/message", version: EVENT_VERSION, content: "old" },
        {
          _tag: "run",
          version: EVENT_VERSION,
          sessionId: "recovery-session",
          runId: "old-run",
          state: "started",
        },
        { _tag: "turn", version: EVENT_VERSION, runId: "old-run", turn: 1, state: "started" },
        {
          _tag: "step",
          version: EVENT_VERSION,
          runId: "old-run",
          turn: 1,
          step: 1,
          state: "started",
        },
        {
          _tag: "model/attempt",
          version: EVENT_VERSION,
          runId: "old-run",
          turn: 1,
          step: 1,
          attempt: 1,
          requestId: "old-request",
          state: "started",
        },
        {
          _tag: "tool/call",
          version: EVENT_VERSION,
          runId: "old-run",
          turn: 1,
          step: 1,
          id: "uncertain",
          name: "danger",
          params: { id: "42" },
        },
      ]
      yield* journal.append("recovery-session", 0, [open[0]!, ...open.slice(1)])
      yield* runAgent(agent, {
        sessionId: "recovery-session",
        prompt: "continue",
      }).pipe(Stream.runDrain)
      const session = yield* journal.load("recovery-session")
      return session.events
    })
    const events = yield* program.pipe(
      Effect.provide(JournalMemory),
      Effect.provideService(LanguageModel.LanguageModel, model),
    )
    assert.strictEqual(yield* Ref.get(executed), 0)
    const unknown = events.find((event) => event._tag === "tool/result" && event.id === "uncertain")
    assert.ok(unknown?._tag === "tool/result")
    if (unknown?._tag === "tool/result") {
      assert.strictEqual(unknown.failureReason, "execution-unknown")
    }
    assert.strictEqual(
      events.findIndex((event) => event._tag === "run" && event.state === "recovered") >= 0,
      true,
    )
  }),
)

const modelFailure = () =>
  AiError.make({
    module: "runtime-test",
    method: "streamText",
    reason: new AiError.UnknownError({ description: "model failed" }),
  })

it.effect("preserves primary and journal failures during terminal finalization", () =>
  Effect.gen(function* () {
    const model = yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () => Stream.fail(modelFailure()),
    })
    const failingJournal = Layer.succeed(
      Journal,
      Journal.of({
        load: (sessionId) =>
          Effect.succeed({ sessionId: SessionId.make(sessionId), revision: 0, events: [] }),
        append: (sessionId, revision, events) =>
          events.some((event) => event._tag === "run" && event.state === "aborted")
            ? Effect.fail(
                new JournalError({
                  operation: "append",
                  sessionId: SessionId.make(sessionId),
                  detail: "terminal append failed",
                }),
              )
            : Effect.succeed(revision + events.length),
      }),
    )
    const exit = yield* Effect.exit(
      runAgent(Agent.make("finalization", Module.empty), {
        sessionId: "finalization-session",
        prompt: "fail",
      }).pipe(
        Stream.runDrain,
        Effect.provide(failingJournal),
        Effect.provideService(LanguageModel.LanguageModel, model),
      ),
    )
    assert.ok(Exit.isFailure(exit))
    const error = Exit.findErrorOption(exit)
    assert.ok(error._tag === "Some")
    if (error._tag === "Some") {
      assert.ok(Schema.is(FinalizationError)(error.value))
      if (Schema.is(FinalizationError)(error.value)) {
        assert.ok(error.value.primary !== undefined)
        assert.ok(Schema.is(JournalError)(error.value.journal))
      }
    }
  }),
)

it.effect("keeps a model-request journal failure in the typed error channel", () =>
  Effect.gen(function* () {
    const model = yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () => Stream.make({ type: "text-delta" as const, id: "done", delta: "done" }),
    })
    const failingJournal = Layer.succeed(
      Journal,
      Journal.of({
        load: (sessionId) =>
          Effect.succeed({ sessionId: SessionId.make(sessionId), revision: 0, events: [] }),
        append: (sessionId, revision, events) =>
          events.some((event) => event._tag === "model/request")
            ? Effect.fail(
                new JournalError({
                  operation: "append",
                  sessionId: SessionId.make(sessionId),
                  detail: "request append failed",
                }),
              )
            : Effect.succeed(revision + events.length),
      }),
    )
    const exit = yield* Effect.exit(
      runAgent(Agent.make("request-journal-failure", Module.empty), {
        sessionId: "request-journal-failure",
        prompt: "run",
      }).pipe(
        Stream.runDrain,
        Effect.provide(failingJournal),
        Effect.provideService(LanguageModel.LanguageModel, model),
      ),
    )
    assert.ok(Exit.isFailure(exit))
    const error = Exit.findErrorOption(exit)
    assert.ok(error._tag === "Some")
    if (error._tag === "Some") assert.ok(Schema.is(JournalError)(error.value))
  }),
)

it.effect("records an aborted run when the consumer interrupts the stream", () =>
  Effect.gen(function* () {
    const modelFinalizers = yield* Ref.make(0)
    const model = yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () =>
        Stream.fromIterable([
          { type: "text-start" as const, id: "text" },
          { type: "text-delta" as const, id: "text", delta: "first" },
          { type: "text-delta" as const, id: "text", delta: "second" },
          { type: "text-end" as const, id: "text" },
        ]).pipe(Stream.ensuring(Ref.update(modelFinalizers, (count) => count + 1))),
    })
    const program = Effect.gen(function* () {
      const journal = yield* Journal
      yield* runAgent(Agent.make("interrupt", Module.empty), {
        sessionId: "interrupt-session",
        prompt: "interrupt",
      }).pipe(Stream.take(1), Stream.runDrain)
      return yield* journal.load("interrupt-session")
    })
    const session = yield* program.pipe(
      Effect.provide(JournalMemory),
      Effect.provideService(LanguageModel.LanguageModel, model),
    )
    const runs = session.events.filter((event) => event._tag === "run")
    assert.strictEqual(runs.length, 2)
    assert.strictEqual(runs[1]?.state, "aborted")
    assert.strictEqual(yield* Ref.get(modelFinalizers), 1)
  }),
)

it.effect("cancelling direct runtime during a tool closes the handler once", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const handlerFinalizers = yield* Ref.make(0)
    const SlowTool = Tool.make("slow_runtime_tool", {
      parameters: Schema.Struct({}),
      success: Schema.String,
    })
    const agent = Agent.make(
      "runtime-tool-cancel",
      Module.tool(SlowTool, () =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Ref.update(handlerFinalizers, (count) => count + 1)),
        ),
      ),
    )
    const model = yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () =>
        Stream.make({
          type: "tool-call" as const,
          id: "slow-call",
          name: "slow_runtime_tool",
          params: {},
        }),
    })
    const program = Effect.gen(function* () {
      const fiber = yield* runAgent(agent, {
        sessionId: "runtime-tool-cancel-session",
        prompt: "wait",
        policy: { toolConcurrency: 1 },
      }).pipe(Stream.runDrain, Effect.forkChild)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      return yield* Ref.get(handlerFinalizers)
    })
    const finalizers = yield* program.pipe(
      Effect.provide(JournalMemory),
      Effect.provideService(LanguageModel.LanguageModel, model),
    )
    assert.strictEqual(finalizers, 1)
  }),
)

it.effect("retries before output with the same logical plan", () =>
  Effect.gen(function* () {
    const renders = yield* Ref.make(0)
    const attempts: Array<{
      readonly planId: string | undefined
      readonly fingerprint: string | undefined
    }> = []
    let primaryCalls = 0
    let fallbackCalls = 0
    const agent = Agent.make("retry", (context) =>
      Effect.gen(function* () {
        yield* Ref.update(renders, (count) => count + 1)
        return yield* Module.instructions(`step ${context.step}`).build(context)
      }),
    )
    const model = yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () => {
        primaryCalls += 1
        return Stream.fail(modelFailure())
      },
    })
    const fallbackModel = yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () => {
        fallbackCalls += 1
        return Stream.make({ type: "text-delta" as const, id: "done", delta: "ok" })
      },
    })
    const fallback = Middleware.make({
      model: (next) => (input) =>
        Stream.unwrap(
          Effect.sync(() => {
            attempts.push({ planId: input.planId, fingerprint: input.fingerprint })
            let emitted = false
            return next(input).pipe(
              Stream.tap(() => Effect.sync(() => (emitted = true))),
              Stream.catchCause((cause) => {
                if (emitted) return Stream.failCause(cause)
                const retry = {
                  ...input,
                  attempt: input.attempt + 1,
                  model: fallbackModel,
                }
                attempts.push({ planId: retry.planId, fingerprint: retry.fingerprint })
                return next(retry)
              }),
            )
          }),
        ),
    })
    const { events, stored } = yield* Effect.gen(function* () {
      const events = yield* runAgent(agent, {
        sessionId: "retry-session",
        prompt: "retry",
        middleware: fallback,
      }).pipe(Stream.runCollect)
      const journal = yield* Journal
      return { events, stored: yield* journal.load("retry-session") }
    }).pipe(
      Effect.provide(JournalMemory),
      Effect.provideService(LanguageModel.LanguageModel, model),
    )

    assert.strictEqual(primaryCalls, 1)
    assert.strictEqual(fallbackCalls, 1)
    assert.strictEqual(yield* Ref.get(renders), 1)
    assert.strictEqual(stored.events.filter((event) => event._tag === "model/request").length, 1)
    assert.deepStrictEqual(
      stored.events
        .filter((event) => event._tag === "model/attempt")
        .map((event) => [event.attempt, event.state]),
      [
        [1, "started"],
        [1, "aborted"],
        [2, "started"],
        [2, "completed"],
      ],
    )
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
    const noDuplicate = Middleware.make({
      model: (next) => (input) =>
        Stream.unwrap(
          Effect.sync(() => {
            let emitted = false
            return next(input).pipe(
              Stream.tap(() => Effect.sync(() => (emitted = true))),
              Stream.catchCause((cause) =>
                emitted ? Stream.failCause(cause) : next({ ...input, attempt: input.attempt + 1 }),
              ),
            )
          }),
        ),
    })
    const exit = yield* Effect.exit(
      runAgent(agent, {
        sessionId: "no-duplicate-session",
        prompt: "answer",
        middleware: noDuplicate,
      }).pipe(
        Stream.runCollect,
        Effect.provide(JournalMemory),
        Effect.provideService(LanguageModel.LanguageModel, model),
      ),
    )
    assert.ok(Exit.isFailure(exit))
    assert.strictEqual(calls, 1)
  }),
)

it.effect("rejects middleware that retries after visible model output", () =>
  Effect.gen(function* () {
    let calls = 0
    const model = yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () => {
        calls += 1
        return Stream.make({ type: "text-delta" as const, id: "partial", delta: "part" }).pipe(
          Stream.concat(Stream.fail(modelFailure())),
        )
      },
    })
    const unsafeRetry = Middleware.make({
      model: (next) => (input) =>
        next(input).pipe(Stream.catchCause(() => next({ ...input, attempt: input.attempt + 1 }))),
    })
    const exit = yield* Effect.exit(
      runAgent(Agent.make("unsafe-retry", Module.empty), {
        sessionId: "unsafe-retry-session",
        prompt: "answer",
        middleware: unsafeRetry,
      }).pipe(
        Stream.runCollect,
        Effect.provide(JournalMemory),
        Effect.provideService(LanguageModel.LanguageModel, model),
      ),
    )

    assert.strictEqual(calls, 1)
    assert.ok(Exit.isFailure(exit))
    const error = Exit.findErrorOption(exit)
    assert.ok(error._tag === "Some")
    if (error._tag === "Some") assert.ok(Schema.is(UnsafeModelRetry)(error.value))
  }),
)

it.effect("prunes only model-facing history and keeps durable input", () =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<Prompt.Prompt | undefined>(undefined)
    const pruning = Middleware.make({
      model: (next) => (input) => next({ ...input, prompt: Prompt.make("pruned view") }),
    })
    const model = yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: (request) =>
        Stream.fromEffect(Ref.set(seen, request.prompt)).pipe(
          Stream.flatMap(() =>
            Stream.make({ type: "text-delta" as const, id: "done", delta: "ok" }),
          ),
        ),
    })
    const stored = yield* Effect.gen(function* () {
      yield* runAgent(Agent.make("pruning", Module.empty), {
        sessionId: "pruning-session",
        prompt: "durable original",
        middleware: pruning,
      }).pipe(Stream.runDrain)
      return yield* (yield* Journal).load("pruning-session")
    }).pipe(
      Effect.provide(JournalMemory),
      Effect.provideService(LanguageModel.LanguageModel, model),
    )
    assert.match(JSON.stringify(yield* Ref.get(seen)), /pruned view/)
    assert.ok(
      stored.events.some(
        (event) => event._tag === "user/message" && event.content === "durable original",
      ),
    )
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
      }).pipe(
        Stream.runCollect,
        Effect.provide(JournalMemory),
        Effect.provideService(LanguageModel.LanguageModel, model),
      ),
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
      }).pipe(
        Stream.runCollect,
        Effect.provide(JournalMemory),
        Effect.provideService(LanguageModel.LanguageModel, model),
      ),
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
    }).pipe(
      Stream.runCollect,
      Effect.provide(JournalMemory),
      Effect.provideService(LanguageModel.LanguageModel, model),
    )
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
      }).pipe(
        Stream.runCollect,
        Effect.provide(JournalMemory),
        Effect.provideService(LanguageModel.LanguageModel, model),
      ),
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
    const { events, stored } = yield* Effect.gen(function* () {
      const events = yield* runAgent(agent, {
        sessionId: "mixed-tools-session",
        prompt: "run both",
      }).pipe(Stream.runCollect)
      const journal = yield* Journal
      return { events, stored: yield* journal.load("mixed-tools-session") }
    }).pipe(
      Effect.provide(JournalMemory),
      Effect.provideService(LanguageModel.LanguageModel, model),
    )
    const calls = stored.events.filter((event) => event._tag === "tool/call")
    const results = stored.events.filter((event) => event._tag === "tool/result")
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
