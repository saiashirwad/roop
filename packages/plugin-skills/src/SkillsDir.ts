import { Plugin } from "@roop/agent/Plugin.ts"
import type { Skill } from "@roop/agent/Skills.ts"
import { Effect, FileSystem, Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"

class SkillNotFound extends Schema.TaggedErrorClass<SkillNotFound>()("SkillNotFound", {
  message: Schema.String,
}) {}

const description = (markdown: string) =>
  (markdown.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "").match(/^description:\s*(.+)$/m)?.[1] ?? ""

export const SkillsDir = (dir: string): Effect.Effect<Plugin, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const entries = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []))
    const contents = new Map<string, string>()
    const skills: Array<Skill> = []
    for (const entry of entries) {
      const markdown = yield* fs.readFileString(`${dir}/${entry}/SKILL.md`).pipe(Effect.option)
      if (markdown._tag === "Some") {
        contents.set(entry, markdown.value)
        skills.push({ id: entry, description: description(markdown.value) })
      }
    }
    if (skills.length === 0) return Plugin({ name: "skills" })

    const toolkit = Toolkit.make(
      Tool.make("skill", {
        description: "Load a skill's full instructions by id",
        parameters: Schema.Struct({ id: Schema.String }),
        success: Schema.Struct({ content: Schema.String }),
        failure: SkillNotFound,
        failureMode: "return",
      }),
    )

    return Plugin({
      name: "skills",
      toolkit,
      handlers: toolkit.toLayer({
        skill: ({ id }) => {
          const content = contents.get(id)
          return content === undefined
            ? Effect.fail(new SkillNotFound({ message: `unknown skill: ${id}` }))
            : Effect.succeed({ content })
        },
      }),
      skills,
      systemPrompt: [
        "Skills are prewritten instructions for specific tasks. When one matches the task, load it with the skill tool and follow it.",
        ...skills.map((skill) => `- ${skill.id}: ${skill.description}`),
      ].join("\n"),
    })
  })
