import { NodeFileSystem } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { Agent } from "@roop/agent/Agent.ts"
import { cryptoWeb } from "@roop/agent/cryptoWeb.ts"
import { AgentPlugins, Plugin } from "@roop/agent/Plugin.ts"
import { deriveMessages } from "@roop/agent/SessionEvent.ts"
import { SessionStoreMemory } from "@roop/agent/SessionStore.ts"
import { Effect, FileSystem, Layer, Path, Ref, Stream } from "effect"
import { LanguageModel, Response } from "effect/unstable/ai"

import { SkillsDir } from "../src/SkillsDir.ts"

const scripted = (turns: ReadonlyArray<ReadonlyArray<Response.StreamPartEncoded>>) =>
  Effect.gen(function* () {
    const index = yield* Ref.make(0)
    return yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () =>
        Stream.unwrap(
          Effect.gen(function* () {
            const i = yield* Ref.getAndUpdate(index, (n) => n + 1)
            return Stream.fromIterable(turns[i] ?? [])
          }),
        ),
    })
  })

const Main = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = yield* fs.makeTempDirectory({ prefix: "skills-" })
    yield* fs.makeDirectory(path.join(dir, "greet"))
    yield* fs.writeFileString(
      path.join(dir, "greet", "SKILL.md"),
      "---\nname: greet\ndescription: Greet the user warmly.\n---\n\nAlways greet with enthusiasm.",
    )
    const skills = yield* SkillsDir(dir)
    return AgentPlugins([
      skills,
      Plugin({
        name: "model",
        models: [
          {
            id: "fake",
            provider: "test",
            layer: Layer.effect(
              LanguageModel.LanguageModel,
              scripted([
                [{ type: "tool-call", id: "c1", name: "skill", params: { id: "greet" } }],
                [{ type: "text-delta", id: "t1", delta: "loaded" }],
              ]),
            ),
          },
        ],
      }),
    ])
  }).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, Path.layer))),
).pipe(Layer.provide(SessionStoreMemory), Layer.provide(cryptoWeb))

it.layer(Main)("SkillsDir", (it) => {
  it.effect("advertises skills and serves their content", () =>
    Effect.gen(function* () {
      const agent = yield* Agent

      const caps = yield* agent.capabilities
      assert.deepStrictEqual(caps.skills, [{ id: "greet", description: "Greet the user warmly." }])

      const events = yield* Stream.runCollect(agent.prompt({ prompt: "hi", sessionId: "s1" })).pipe(
        Effect.map((chunk) => [...chunk]),
      )
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      const result = events.find((event: any) => event._tag === "ToolResult") as any
      assert.strictEqual(result.isFailure, false)
      assert.ok(result.result.content.includes("Always greet with enthusiasm."))

      const session = yield* agent.history("s1")
      const first = deriveMessages(session.events)[0]
      assert.ok(first !== undefined && first.role === "system" && first.content.includes("greet:"))
    }),
  )
})
