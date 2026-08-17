import { NodeFileSystem } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { Agent } from "@roop/agent/Agent.ts"
import { cryptoWeb } from "@roop/agent/cryptoWeb.ts"
import { AgentPlugins, Plugin } from "@roop/agent/Plugin.ts"
import { deriveMessages } from "@roop/agent/SessionEvent.ts"
import { SessionJournalMemory } from "@roop/agent/SessionJournal.ts"
import { scripted } from "@roop/agent/Testing.ts"
import { Effect, Exit, FileSystem, Layer, Option, Path, PlatformError, Stream } from "effect"
import { LanguageModel } from "effect/unstable/ai"

import { SkillsDir } from "../src/SkillsDir.ts"

const Main = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const dir = yield* fs.makeTempDirectory({ prefix: "skills-" })
    yield* fs.writeFileString(path.join(dir, "README.md"), "This is not a skill.")
    yield* fs.makeDirectory(path.join(dir, "greet"))
    yield* fs.writeFileString(
      path.join(dir, "greet", "SKILL.md"),
      "---\nname: greet\ndescription: Greet the user warmly.\n---\n\nAlways greet with enthusiasm.",
    )
    yield* fs.makeDirectory(path.join(dir, "block"))
    yield* fs.writeFileString(
      path.join(dir, "block", "SKILL.md"),
      "---\r\nname: block\r\ndescription: >\r\n  Read the instructions\r\n\r\n  one line at a time.\r\n---\r\n",
    )
    yield* fs.makeDirectory(path.join(dir, "literal"))
    yield* fs.writeFileString(
      path.join(dir, "literal", "SKILL.md"),
      "---\r\nname: literal\r\ndescription: |\r\n  Keep each line\r\n  exactly as written.\r\n---\r\n",
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
).pipe(Layer.provide(SessionJournalMemory), Layer.provide(cryptoWeb))

it.layer(Main)("SkillsDir", (it) => {
  it.effect("advertises skills and serves their content", () =>
    Effect.gen(function* () {
      const agent = yield* Agent

      const caps = yield* agent.capabilities
      assert.deepStrictEqual(caps.skills, [
        { id: "block", description: "Read the instructions\none line at a time.\n" },
        { id: "greet", description: "Greet the user warmly." },
        { id: "literal", description: "Keep each line\nexactly as written.\n" },
      ])

      const events = yield* Stream.runCollect(agent.prompt({ prompt: "hi", sessionId: "s1" })).pipe(
        Effect.map((chunk) => [...chunk]),
      )
      /* SAFETY: This fixture constructs the exact runtime shape required by the test. */
      const result = events.find((event) => event._tag === "ToolResult") as any
      assert.strictEqual(result.isFailure, false)
      assert.ok(result.result.content.includes("Always greet with enthusiasm."))

      const session = yield* agent.history("s1")
      const first = deriveMessages(session.events)[0]
      assert.ok(first !== undefined && first.role === "system" && first.content.includes("greet:"))
    }),
  )
})

it.effect("ignores only missing directories and skill files", () =>
  Effect.gen(function* () {
    const missing = yield* SkillsDir("missing").pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readDirectory: () =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "NotFound",
                module: "FileSystem",
                method: "readDirectory",
              }),
            ),
        }),
      ),
      Effect.exit,
    )
    assert.ok(Exit.isSuccess(missing))

    const denied = yield* SkillsDir("denied").pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readDirectory: () =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "readDirectory",
              }),
            ),
        }),
      ),
      Effect.exit,
    )
    assert.ok(Exit.isFailure(denied))

    const deniedFile = yield* SkillsDir("denied-file").pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readDirectory: () => Effect.succeed(["skill"]),
          stat: () =>
            Effect.succeed({
              type: "Directory",
              mtime: Option.none(),
              atime: Option.none(),
              birthtime: Option.none(),
              dev: 0,
              ino: Option.none(),
              mode: 0,
              nlink: Option.none(),
              uid: Option.none(),
              gid: Option.none(),
              rdev: Option.none(),
              size: FileSystem.Size(0),
              blksize: Option.none(),
              blocks: Option.none(),
            } satisfies FileSystem.File.Info),
          readFileString: () =>
            Effect.fail(
              PlatformError.systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "readFileString",
              }),
            ),
        }),
      ),
      Effect.exit,
    )
    assert.ok(Exit.isFailure(deniedFile))
  }),
)
