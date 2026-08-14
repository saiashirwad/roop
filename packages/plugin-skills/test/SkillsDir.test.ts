import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { NodeFileSystem } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { Agent } from "@roop/agent/Agent.ts"
import { AgentPlugins, Plugin } from "@roop/agent/Plugin.ts"
import { SessionStoreMemory } from "@roop/agent/SessionStore.ts"
import { Effect, Layer, Ref, Stream } from "effect"
import { LanguageModel } from "effect/unstable/ai"

import { SkillsDir } from "../src/SkillsDir.ts"

const scripted = (turns: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>) =>
  Effect.gen(function* () {
    const index = yield* Ref.make(0)
    return yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () =>
        Stream.unwrap(
          Effect.gen(function* () {
            const i = yield* Ref.getAndUpdate(index, (n) => n + 1)
            return Stream.fromIterable((turns[i] ?? []) as never)
          }),
        ),
    })
  })

const dir = mkdtempSync(join(tmpdir(), "skills-"))
mkdirSync(join(dir, "greet"))
writeFileSync(
  join(dir, "greet", "SKILL.md"),
  "---\nname: greet\ndescription: Greet the user warmly.\n---\n\nAlways greet with enthusiasm.",
)

const Main = Layer.unwrap(
  Effect.gen(function* () {
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
  }).pipe(Effect.provide(NodeFileSystem.layer)),
).pipe(Layer.provide(SessionStoreMemory))

it.layer(Main)("SkillsDir", (it) => {
  it.effect("advertises skills and serves their content", () =>
    Effect.gen(function* () {
      const agent = yield* Agent

      const caps = yield* agent.capabilities()
      assert.deepStrictEqual(caps.skills, [{ id: "greet", description: "Greet the user warmly." }])

      const events = yield* Stream.runCollect(agent.prompt({ prompt: "hi", sessionId: "s1" })).pipe(
        Effect.map((chunk) => [...chunk]),
      )
      const result = events.find((event: any) => event._tag === "ToolResult") as any
      assert.strictEqual(result.isFailure, false)
      assert.ok(result.result.content.includes("Always greet with enthusiasm."))

      const session = yield* agent.history("s1")
      assert.ok(String(session.messages[0]!.content).includes("greet:"))
    }),
  )
})
