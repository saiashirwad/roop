import { Plugin } from "@roop/agent/Plugin.ts"
import type { Skill } from "@roop/agent/Skills.ts"
import { Effect, FileSystem, Option, type PlatformError, Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"

class SkillNotFound extends Schema.TaggedErrorClass<SkillNotFound>()("SkillNotFound", {
  message: Schema.String,
}) {}

const frontmatter = (markdown: string): string | undefined => {
  const opening = markdown.match(/^(?:\uFEFF)?---[ \t]*(?:\r?\n|$)/)
  if (opening === null) return undefined

  const rest = markdown.slice(opening[0].length)
  const closing = rest.search(/^---[ \t]*(?:\r?\n|$)/m)
  return closing === -1 ? undefined : rest.slice(0, closing)
}

const unquote = (value: string): string => {
  if (value.length < 2) return value
  const first = value[0]
  const last = value[value.length - 1]
  if (first === "'" && last === "'") return value.slice(1, -1).replace(/''/g, "'")
  if (first === '"' && last === '"') {
    try {
      /* SAFETY: YAML's double-quoted scalar syntax always decodes to a string here. */
      return JSON.parse(value) as string
    } catch {
      return value.slice(1, -1)
    }
  }
  return value
}

const blockDescription = (
  lines: ReadonlyArray<string>,
  start: number,
  folded: boolean,
  chomp: string,
) => {
  const block: Array<string> = []
  for (let index = start; index < lines.length; index++) {
    const line = lines[index]!
    if (line.trim() !== "" && !/^\s+/.test(line)) break
    block.push(line)
  }

  const indent = block
    .filter((line) => line.trim() !== "")
    .reduce((minimum, line) => Math.min(minimum, line.match(/^ */)![0].length), Infinity)
  const content = block.map((line) => (line.trim() === "" ? "" : line.slice(indent)))
  let value = folded
    ? content.reduce((result, line, index) => {
        if (index === 0) return line
        const previous = content[index - 1]!
        return `${result}${line === "" ? "\n" : previous === "" ? "" : " "}${line}`
      }, "")
    : content.join("\n")

  if (chomp === "-") value = value.replace(/\n+$/, "")
  else if (chomp !== "+") value = value.replace(/\n*$/, "\n")
  return value
}

/** Read the description key from the small YAML frontmatter dialect used by SKILL.md files. */
const description = (markdown: string): string => {
  const metadata = frontmatter(markdown)
  if (metadata === undefined) return ""

  const lines = metadata.replace(/\r\n/g, "\n").split("\n")
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index]!.match(/^description[ \t]*:[ \t]*(.*)$/)
    if (match === null) continue
    const value = match[1]!
    const block = value.match(/^([|>])([+-]?)(?:[ \t]*)$/)
    return block === null
      ? unquote(value.trim())
      : blockDescription(lines, index + 1, block[1] === ">", block[2] ?? "")
  }
  return ""
}

const isNotFound = (error: PlatformError.PlatformError): boolean => error.reason._tag === "NotFound"

export const SkillsDir = (
  dir: string,
): Effect.Effect<Plugin, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const entries = yield* fs
      .readDirectory(dir)
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          isNotFound(error) ? Effect.succeed([]) : Effect.fail(error),
        ),
      )
    const contents = new Map<string, string>()
    const skills: Array<Skill> = []
    for (const entry of entries.toSorted((left, right) => left.localeCompare(right))) {
      const entryPath = `${dir}/${entry}`
      const entryInfo = yield* fs.stat(entryPath).pipe(
        Effect.map(Option.some),
        Effect.catchTag("PlatformError", (error) =>
          isNotFound(error)
            ? Effect.succeed(Option.none<FileSystem.File.Info>())
            : Effect.fail(error),
        ),
      )
      // readDirectory may include ordinary files alongside skill directories.
      // Stat first so those entries are ignored without masking permission or
      // other real filesystem errors from SKILL.md reads.
      if (entryInfo._tag === "None" || entryInfo.value.type !== "Directory") continue

      const markdown = yield* fs.readFileString(`${dir}/${entry}/SKILL.md`).pipe(
        Effect.map(Option.some),
        Effect.catchTag("PlatformError", (error) =>
          isNotFound(error) ? Effect.succeed(Option.none<string>()) : Effect.fail(error),
        ),
      )
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
