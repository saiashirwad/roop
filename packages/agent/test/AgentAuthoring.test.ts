/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- vitest assertions inspect dynamic event shapes */

import { assert, it } from "@effect/vitest"
import { Agent, DomainIds, Journal, Middleware, Roop, ToolExecutionContext } from "@roop/agent"
import { Context, Effect, Layer, Ref, Schema, Stream } from "effect"
import { LanguageModel, type Response, Tool } from "effect/unstable/ai"

const scripted = (turns: ReadonlyArray<ReadonlyArray<Response.StreamPartEncoded>>) =>
  Effect.gen(function* () {
    const index = yield* Ref.make(0)
    return yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () =>
        Stream.unwrap(
          Effect.gen(function* () {
            const current = yield* Ref.getAndUpdate(index, (value) => value + 1)
            return Stream.fromIterable(turns[current] ?? [])
          }),
        ),
    })
  })

it.effect("Agent.run returns AgentResult with text and finish reason", () =>
  Effect.gen(function* () {
    const model = yield* scripted([
      [
        { type: "text-delta", id: "1", delta: "Hello " },
        { type: "text-delta", id: "2", delta: "world!" },
      ],
    ])

    const assistant = Agent.make({
      name: "greeter",
      instructions: "You are a friendly greeter.",
    })

    const Live = Roop.layer({
      model,
      journal: Journal.memory,
    })

    const result = yield* Agent.run(assistant, {
      sessionId: "session-1",
      prompt: "Hi",
    }).pipe(Effect.provide(Live))

    assert.strictEqual(result.sessionId, DomainIds.SessionId.make("session-1"))
    assert.strictEqual(result.text, "Hello world!")
    assert.strictEqual(result.finishReason, "completed")
    assert.deepStrictEqual(result.toolCalls, [])
    assert.deepStrictEqual(result.toolResults, [])
  }),
)

it.effect("Agent.streamText yields only text deltas", () =>
  Effect.gen(function* () {
    const model = yield* scripted([
      [
        { type: "reasoning-delta", id: "r1", delta: "thinking..." },
        { type: "text-delta", id: "t1", delta: "Chunk 1; " },
        { type: "text-delta", id: "t2", delta: "Chunk 2" },
      ],
    ])

    const assistant = Agent.make({
      name: "streamer",
      instructions: "Stream output.",
    })

    const Live = Roop.layer({
      model,
      journal: Journal.memory,
    })

    const chunks = yield* Agent.streamText(assistant, {
      sessionId: "session-2",
      prompt: "Stream",
    }).pipe(Stream.runCollect, Effect.provide(Live))

    assert.deepStrictEqual([...chunks], ["Chunk 1; ", "Chunk 2"])
  }),
)

it.effect("Agent.session maintains multi-turn conversation and durable history", () =>
  Effect.gen(function* () {
    const model = yield* scripted([
      [{ type: "text-delta", id: "1", delta: "Turn 1 answer" }],
      [{ type: "text-delta", id: "2", delta: "Turn 2 answer" }],
    ])

    const assistant = Agent.make({
      name: "conversational",
      instructions: "Remember user context.",
    })

    const Live = Roop.layer({
      model,
      journal: Journal.memory,
    })

    const session = Agent.session(assistant, "conv-session-1")

    const res1 = yield* session.run("First message").pipe(Effect.provide(Live))
    assert.strictEqual(res1.text, "Turn 1 answer")

    const res2 = yield* session.run("Second message").pipe(Effect.provide(Live))
    assert.strictEqual(res2.text, "Turn 2 answer")

    const journal = yield* Journal.Journal
    const snapshot = yield* journal.load("conv-session-1")
    assert.ok(snapshot.events.length >= 4)
  }).pipe(Effect.provide(Journal.memory)),
)

it.effect("Agent.tool and Agent.capability compose with typed services", () =>
  Effect.gen(function* () {
    class Database extends Context.Service<
      Database,
      { readonly query: (id: string) => Effect.Effect<string> }
    >()("test/Database") {}

    const lookupToolDef = Tool.make("lookup", {
      description: "Lookup data",
      parameters: Schema.Struct({ id: Schema.String }),
      success: Schema.Struct({ value: Schema.String }),
    })

    const lookupTool = Agent.tool(lookupToolDef, ({ id }) =>
      Effect.gen(function* () {
        const db = yield* Database
        const value = yield* db.query(id)
        return { value }
      }),
    )

    const dataCapability = Agent.capability({
      name: "data-access",
      instructions: "Access database data.",
      tools: [lookupTool],
    })

    const agent = Agent.make({
      name: "data-agent",
      capabilities: [dataCapability],
    })

    const model = yield* scripted([
      [{ type: "tool-call", id: "call-1", name: "lookup", params: { id: "item-42" } }],
      [{ type: "text-delta", id: "t1", delta: "Found data for item-42" }],
    ])

    const DatabaseLive = Layer.succeed(Database, {
      query: (id) => Effect.succeed(`result-for-${id}`),
    })

    const Live = Layer.mergeAll(
      Roop.layer({
        model,
        journal: Journal.memory,
      }),
      DatabaseLive,
    )

    const result = yield* Agent.run(agent, {
      sessionId: "session-tools",
      prompt: "Lookup item-42",
    }).pipe(Effect.provide(Live))

    assert.strictEqual(result.text, "Found data for item-42")
    assert.strictEqual(result.toolCalls.length, 1)
    assert.strictEqual(result.toolCalls[0]!.name, "lookup")
    assert.deepStrictEqual(result.toolResults[0]!.result, { value: "result-for-item-42" })
  }),
)

it.effect("ToolExecutionContext is provided to tool handlers", () =>
  Effect.gen(function* () {
    const capturedContext = yield* Ref.make<{
      readonly sessionId: DomainIds.SessionId
      readonly runId: DomainIds.RunId
      readonly turn: number
      readonly step: number
      readonly callId: string
    } | null>(null)

    const inspectToolDef = Tool.make("inspect", {
      description: "Inspect execution context",
      parameters: Schema.Struct({}),
      success: Schema.Struct({ ok: Schema.Boolean }),
    })

    const inspectTool = Agent.tool(inspectToolDef, () =>
      Effect.gen(function* () {
        const ctx = yield* ToolExecutionContext
        yield* Ref.set(capturedContext, ctx)
        return { ok: true }
      }),
    )

    const agent = Agent.make({
      name: "inspector-agent",
      tools: [inspectTool],
    })

    const model = yield* scripted([
      [{ type: "tool-call", id: "call-inspect", name: "inspect", params: {} }],
      [{ type: "text-delta", id: "t1", delta: "Inspection complete" }],
    ])

    const Live = Roop.layer({
      model,
      journal: Journal.memory,
    })

    yield* Agent.run(agent, {
      sessionId: "inspect-session-99",
      prompt: "Run inspection",
    }).pipe(Effect.provide(Live))

    const captured = yield* Ref.get(capturedContext)
    assert.ok(captured !== null)
    assert.strictEqual(captured!.sessionId, DomainIds.SessionId.make("inspect-session-99"))
    assert.strictEqual(captured!.turn, 1)
    assert.strictEqual(captured!.step, 1)
    assert.ok(captured!.callId.length > 0)
  }),
)

it.effect(
  "Agent.delegate orchestrates child agent with deterministic session and Subagent events",
  () =>
    Effect.gen(function* () {
      const journal = yield* Journal.Journal

      const childAgent = Agent.make({
        name: "researcher",
        instructions: "You are a specialized researcher.",
      })

      const leadAgent = Agent.make({
        name: "lead",
        instructions: "Delegate research to researcher.",
        tools: [
          Agent.delegate(childAgent, {
            name: "delegate_research",
            description: "Delegate research to specialist",
            parameters: Schema.Struct({ topic: Schema.String }),
            prompt: ({ topic }) => `Research: ${topic}`,
          }),
        ],
      })

      const model = yield* scripted([
        // 1. Parent initiates delegation tool call
        [
          {
            type: "tool-call",
            id: "call-del",
            name: "delegate_research",
            params: { topic: "Effect" },
          },
        ],
        // 2. Child researcher responds with research findings
        [{ type: "text-delta", id: "c1", delta: "Child specialist research findings." }],
        // 3. Parent synthesizes final reply
        [{ type: "text-delta", id: "p1", delta: "Synthesized: findings received." }],
      ])

      const allEvents: Array<unknown> = []
      const Live = Roop.layer({
        model,
        journal: Layer.succeed(Journal.Journal, journal),
      })

      yield* Agent.events(leadAgent, {
        sessionId: "lead-session-10",
        prompt: "Research Effect",
      }).pipe(
        Stream.tap((event) => Effect.sync(() => allEvents.push(event))),
        Stream.runDrain,
        Effect.provide(Live),
      )

      // Check that subagent event was emitted
      const subagentEvents = allEvents.filter(
        (e): e is { _tag: "Subagent"; name: string; toolCallId?: string; event: unknown } =>
          /* SAFETY: test assertion narrows event shape by checking _tag discriminator */
          typeof e === "object" && e !== null && (e as any)._tag === "Subagent",
      )
      assert.ok(subagentEvents.length > 0)
      assert.strictEqual(subagentEvents[0]!.name, "researcher")

      // Check child session was stored in journal
      const toolCallId = subagentEvents[0]!.toolCallId!
      const childSnapshot = yield* journal.load(`lead-session-10/agents/researcher/${toolCallId}`)
      assert.ok(childSnapshot.events.length > 0)
    }).pipe(Effect.provide(Journal.memory)),
)

it.effect("Agent.when conditionally enables capability via Effect boolean", () =>
  Effect.gen(function* () {
    class UserRole extends Context.Service<UserRole, { readonly isAdmin: boolean }>()(
      "test/UserRole",
    ) {}

    const adminToolDef = Tool.make("admin_action", {
      description: "Perform admin action",
      parameters: Schema.Struct({}),
      success: Schema.Struct({ done: Schema.Boolean }),
    })

    const adminCapability = Agent.capability({
      name: "admin-cap",
      instructions: "Admin privileges enabled.",
      tools: [Agent.tool(adminToolDef, () => Effect.succeed({ done: true }))],
    })

    const agent = Agent.make({
      name: "conditional-agent",
      capabilities: [Agent.when(UserRole.pipe(Effect.map((u) => u.isAdmin)), adminCapability)],
    })

    const model = yield* scripted([
      [{ type: "tool-call", id: "c1", name: "admin_action", params: {} }],
      [{ type: "text-delta", id: "t1", delta: "Admin action complete" }],
    ])

    const Live = Layer.mergeAll(
      Roop.layer({
        model,
        journal: Journal.memory,
      }),
      Layer.succeed(UserRole, { isAdmin: true }),
    )

    const result = yield* Agent.run(agent, {
      sessionId: "cond-session",
      prompt: "Run admin",
    }).pipe(Effect.provide(Live))

    assert.strictEqual(result.text, "Admin action complete")
    assert.strictEqual(result.toolCalls.length, 1)
  }),
)

it.effect("Agent.withMiddleware and Agent.withPolicy configure agent defaults", () =>
  Effect.gen(function* () {
    const middlewareRan = yield* Ref.make(false)

    const testMiddleware: Middleware.Middleware = Middleware.make({
      turn: (next) => (input) => Ref.set(middlewareRan, true).pipe(Effect.andThen(next(input))),
    })

    const baseAgent = Agent.make({
      name: "customized-agent",
      instructions: "Test agent",
    })

    const configuredAgent = baseAgent.pipe(
      Agent.withMiddleware(testMiddleware),
      Agent.withPolicy({ maxTurns: 5 }),
    )

    assert.strictEqual(configuredAgent.policy?.maxTurns, 5)

    const model = yield* scripted([[{ type: "text-delta", id: "1", delta: "ok" }]])
    const Live = Roop.layer({
      model,
      journal: Journal.memory,
    })

    const result = yield* Agent.run(configuredAgent, {
      sessionId: "mw-session",
      prompt: "hello",
    }).pipe(Effect.provide(Live))

    assert.strictEqual(result.text, "ok")
    assert.strictEqual(yield* Ref.get(middlewareRan), true)
  }),
)
