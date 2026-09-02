import { assert, it } from "@effect/vitest"
import { Deferred, Effect, Exit, Fiber, Option, Ref, Schema, Stream } from "effect"
import { LanguageModel, type Response, Tool } from "effect/unstable/ai"

import { Agent } from "../src/Agent.ts"
import { fromEvents } from "../src/AgentResult.ts"
import { Inbox, RunEnded } from "../src/Inbox.ts"
import { Journal } from "../src/Journal.ts"
import { JournalMemory } from "../src/JournalMemory.ts"
import { Module } from "../src/Module.ts"
import { startAgent } from "../src/Runtime.ts"
import { scripted } from "../src/Testing.ts"

const Slow = Tool.make("slow", { parameters: Schema.Struct({}), success: Schema.String })

const toolCall = (id: string): Response.StreamPartEncoded => ({
  type: "tool-call",
  id,
  name: "slow",
  params: {},
})
const text = (delta: string): Response.StreamPartEncoded => ({ type: "text-delta", id: "t", delta })

const promptText = (content: ReadonlyArray<unknown>) => JSON.stringify(content)

it.effect("the handle result is the fold of the handle's events", () =>
  Effect.gen(function* () {
    const model = yield* scripted([[text("hello "), text("world")]])
    const { events, result } = yield* Effect.gen(function* () {
      const handle = yield* startAgent(Agent.make("handle", Module.empty), {
        sessionId: "handle",
        prompt: "hi",
      })
      const collecting = yield* Effect.forkChild(Stream.runCollect(handle.events))
      const result = yield* handle.result
      return { events: yield* Fiber.join(collecting), result }
    }).pipe(
      Effect.scoped,
      Effect.provide(JournalMemory),
      Effect.provideService(LanguageModel.LanguageModel, model),
    )
    assert.strictEqual(result.text, "hello world")
    assert.strictEqual(result.finishReason, "completed")
    assert.strictEqual(result.runId, "handle:0")
    assert.deepStrictEqual(Option.some(result), fromEvents(events))
    assert.strictEqual(events[0]?._tag, "user/message")
    assert.ok(events.at(-1)?._tag === "run")
  }),
)

it.effect("closing the scope interrupts the run and settles it as interrupted", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>()
    const model = yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () =>
        Stream.make(text("first")).pipe(
          Stream.concat(Stream.fromEffectDrain(Deferred.succeed(started, undefined))),
          Stream.concat(Stream.never),
        ),
    })
    const program = Effect.gen(function* () {
      const handle = yield* Effect.gen(function* () {
        const handle = yield* startAgent(Agent.make("scoped", Module.empty), {
          sessionId: "scoped",
          prompt: "wait",
        })
        yield* Deferred.await(started)
        return handle
      }).pipe(Effect.scoped)
      const result = yield* handle.result
      assert.strictEqual(result.finishReason, "interrupted")
      assert.strictEqual(result.text, "first")
      const stored = yield* (yield* Journal).load("scoped")
      const runs = stored.events.filter((event) => event._tag === "run")
      assert.deepStrictEqual(
        runs.map((event) => [event.state, event.reason]),
        [
          ["started", undefined],
          ["aborted", "interrupted"],
        ],
      )
      const send = yield* Effect.exit(handle.send({ _tag: "user/message", content: "late" }))
      assert.ok(Exit.isFailure(send))
    })
    yield* program.pipe(
      Effect.provide(JournalMemory),
      Effect.provideService(LanguageModel.LanguageModel, model),
    )
  }),
)

it.effect("a message sent during a tool call lands after that step and in the next request", () =>
  Effect.gen(function* () {
    const prompts = yield* Ref.make<Array<ReadonlyArray<unknown>>>([])
    const toolStarted = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const model = yield* scripted([[toolCall("c1")], [text("done")]], prompts)
    const agent = Agent.make(
      "steer",
      Module.tool(Slow, () =>
        Deferred.succeed(toolStarted, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as("slow result"),
        ),
      ),
    )
    const { result, stored } = yield* Effect.gen(function* () {
      const handle = yield* startAgent(agent, { sessionId: "steer", prompt: "go" })
      yield* Deferred.await(toolStarted)
      yield* handle.send({ _tag: "user/message", content: "also update the tests" })
      yield* Deferred.succeed(release, undefined)
      const result = yield* handle.result
      return { result, stored: yield* (yield* Journal).load("steer") }
    }).pipe(
      Effect.scoped,
      Effect.provide(JournalMemory),
      Effect.provideService(LanguageModel.LanguageModel, model),
    )
    assert.strictEqual(result.finishReason, "completed")
    assert.strictEqual(result.text, "done")
    const tags = stored.events.map((event) => event._tag)
    const resultIndex = tags.indexOf("tool/result")
    const steerIndex = stored.events.findIndex(
      (event) => event._tag === "user/message" && event.content === "also update the tests",
    )
    const secondStep = stored.events.findIndex(
      (event) => event._tag === "step" && event.step === 2 && event.state === "started",
    )
    assert.ok(resultIndex >= 0 && resultIndex < steerIndex && steerIndex < secondStep)
    // The message follows the first step's terminal event.
    assert.strictEqual(
      stored.events[steerIndex - 1]?._tag,
      "step",
      "user/message follows the step's terminal event",
    )
    const seen = yield* Ref.get(prompts)
    assert.strictEqual(seen.length, 2)
    assert.ok(!promptText(seen[0]!).includes("also update the tests"))
    const second = promptText(seen[1]!)
    assert.ok(second.indexOf("slow result") < second.indexOf("also update the tests"))
  }),
)

it.effect("a message sent during a final answer runs another step", () =>
  Effect.gen(function* () {
    const prompts = yield* Ref.make<Array<ReadonlyArray<unknown>>>([])
    const answering = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const calls = yield* Ref.make(0)
    const model = yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: (options) =>
        Stream.unwrap(
          Effect.gen(function* () {
            yield* Ref.update(prompts, (all) => [...all, options.prompt.content])
            const call = yield* Ref.updateAndGet(calls, (n) => n + 1)
            if (call > 1) return Stream.make(text("and the tests"))
            return Stream.make(text("answer ")).pipe(
              Stream.concat(Stream.fromEffectDrain(Deferred.succeed(answering, undefined))),
              Stream.concat(Stream.fromEffectDrain(Deferred.await(release))),
            )
          }),
        ),
    })
    const { result, stored } = yield* Effect.gen(function* () {
      const handle = yield* startAgent(Agent.make("talk", Module.empty), {
        sessionId: "talk",
        prompt: "go",
      })
      yield* Deferred.await(answering)
      yield* handle.send({ _tag: "user/message", content: "what about the tests?" })
      yield* Deferred.succeed(release, undefined)
      const result = yield* handle.result
      return { result, stored: yield* (yield* Journal).load("talk") }
    }).pipe(
      Effect.scoped,
      Effect.provide(JournalMemory),
      Effect.provideService(LanguageModel.LanguageModel, model),
    )
    assert.strictEqual(result.text, "answer and the tests")
    assert.strictEqual(result.finishReason, "completed")
    assert.strictEqual(stored.events.filter((event) => event._tag === "user/message").length, 2)
    assert.strictEqual(
      stored.events.filter((event) => event._tag === "step" && event.state === "started").length,
      2,
    )
    const seen = yield* Ref.get(prompts)
    assert.strictEqual(seen.length, 2)
    const second = promptText(seen[1]!)
    assert.ok(second.indexOf("answer ") < second.indexOf("what about the tests?"))
  }),
)

it.effect("send fails with RunEnded after the run completes", () =>
  Effect.gen(function* () {
    const model = yield* scripted([[text("done")]])
    const exit = yield* Effect.gen(function* () {
      const handle = yield* startAgent(Agent.make("ended", Module.empty), {
        sessionId: "ended",
        prompt: "go",
      })
      yield* handle.result
      return yield* Effect.exit(handle.send({ _tag: "user/message", content: "too late" }))
    }).pipe(
      Effect.scoped,
      Effect.provide(JournalMemory),
      Effect.provideService(LanguageModel.LanguageModel, model),
    )
    assert.ok(Exit.isFailure(exit))
    const error = Option.getOrThrow(Exit.findErrorOption(exit))
    assert.ok(Schema.is(RunEnded)(error))
    assert.strictEqual(error.runId, "ended:0")
    assert.strictEqual(error.message, "Run 'ended:0' has ended and no longer accepts messages")
  }),
)

it.effect("a step limit closes the inbox and keeps what it held as user messages", () =>
  Effect.gen(function* () {
    const toolStarted = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const model = yield* scripted([[toolCall("c1")], [toolCall("c2")]])
    const agent = Agent.make(
      "limit",
      Module.tool(Slow, () =>
        Deferred.succeed(toolStarted, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as("slow result"),
        ),
      ),
    )
    const { result, late, stored } = yield* Effect.gen(function* () {
      const handle = yield* startAgent(agent, {
        sessionId: "limit",
        prompt: "go",
        policy: { maxStepsPerTurn: 1 },
      })
      yield* Deferred.await(toolStarted)
      yield* handle.send({ _tag: "user/message", content: "pending at the limit" })
      yield* Deferred.succeed(release, undefined)
      const result = yield* handle.result
      const late = yield* Effect.exit(handle.send({ _tag: "user/message", content: "late" }))
      return { result, late, stored: yield* (yield* Journal).load("limit") }
    }).pipe(
      Effect.scoped,
      Effect.provide(JournalMemory),
      Effect.provideService(LanguageModel.LanguageModel, model),
    )
    assert.strictEqual(result.finishReason, "stopped")
    assert.ok(Exit.isFailure(late))
    const users = stored.events.filter((event) => event._tag === "user/message")
    assert.deepStrictEqual(
      users.map((event) => event.content),
      ["go", "pending at the limit"],
    )
    const tags = stored.events.map((event) => event._tag)
    assert.ok(tags.lastIndexOf("user/message") > tags.indexOf("tool/result"))
    assert.strictEqual(stored.events.filter((event) => event._tag === "model/request").length, 1)
  }),
)

it.effect("a tool handler can poll the inbox for messages sent to the run", () =>
  Effect.gen(function* () {
    const toolStarted = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const polled = yield* Ref.make<ReadonlyArray<string>>([])
    const model = yield* scripted([[toolCall("c1")], [text("done")]])
    const agent = Agent.make({
      name: "poll",
      tools: [
        Agent.tool(Slow, () =>
          Effect.gen(function* () {
            const inbox = yield* Inbox
            yield* Deferred.succeed(toolStarted, undefined)
            yield* Deferred.await(release)
            const message = yield* inbox.poll
            yield* Ref.set(polled, Option.toArray(Option.map(message, (m) => m.content)))
            return "slow result"
          }),
        ),
      ],
    })
    const stored = yield* Effect.gen(function* () {
      const handle = yield* startAgent(agent, { sessionId: "poll", prompt: "go" })
      yield* Deferred.await(toolStarted)
      yield* handle.send({ _tag: "user/message", content: "stop early" })
      yield* Deferred.succeed(release, undefined)
      yield* handle.result
      return yield* (yield* Journal).load("poll")
    }).pipe(
      Effect.scoped,
      Effect.provide(JournalMemory),
      Effect.provideService(LanguageModel.LanguageModel, model),
    )
    assert.deepStrictEqual(yield* Ref.get(polled), ["stop early"])
    // The handler took the message, so the interpreter had nothing to commit.
    assert.strictEqual(stored.events.filter((event) => event._tag === "user/message").length, 1)
  }),
)
