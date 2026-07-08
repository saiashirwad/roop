import { Effect, FileSystem, Schema } from "effect"
import { Tool } from "effect/unstable/ai"

import { ToolFailure, toToolFailure } from "./failure.ts"
import { isTrue, llmOptional, nonEmptyString } from "./params.ts"
import { isIgnoredPath } from "./workspace.ts"

const maxMatches = 100
const maxFileBytes = 1_000_000

export const Grep = Tool.make("grep", {
  description:
    "Search for a text or regex pattern in workspace files. Skips dependency/vendor directories. Results are capped.",
  parameters: Schema.Struct({
    pattern: Schema.String.annotate({
      description: "Literal text or JavaScript regular expression pattern to search for",
    }),
    path: llmOptional(
      Schema.String.annotate({
        description: "Relative file or directory to search. Defaults to the workspace root.",
      }),
    ),
    caseInsensitive: llmOptional(
      Schema.Boolean.annotate({
        description: "Case-insensitive search. Defaults to false.",
      }),
    ),
    literal: llmOptional(
      Schema.Boolean.annotate({
        description:
          "Treat pattern as plain text instead of a regular expression. Defaults to false.",
      }),
    ),
  }),
  success: Schema.Struct({
    pattern: Schema.String,
    path: Schema.String,
    matches: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        line: Schema.Number,
        text: Schema.String,
      }),
    ),
    totalMatches: Schema.Number,
    truncated: Schema.Boolean,
  }),
  failure: ToolFailure,
  failureMode: "return",
})

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export const grepHandlers = (fs: FileSystem.FileSystem) => ({
  grep: Effect.fn("tools/grep")(function* ({
    pattern,
    path,
    caseInsensitive,
    literal,
  }: {
    pattern: string
    path?: string | null | undefined
    caseInsensitive?: boolean | null | undefined
    literal?: boolean | null | undefined
  }) {
    if (pattern.length === 0) {
      return yield* Effect.fail({
        message: "pattern must not be empty",
        reason: "InvalidInput",
      } satisfies ToolFailure)
    }

    const root = nonEmptyString(path) ?? "."
    let regex: RegExp
    try {
      const source = isTrue(literal) ? escapeRegExp(pattern) : pattern
      regex = new RegExp(source, isTrue(caseInsensitive) ? "i" : undefined)
    } catch (error) {
      return yield* Effect.fail({
        message: error instanceof Error ? error.message : String(error),
        reason: "InvalidInput",
      } satisfies ToolFailure)
    }

    const isDirectory = yield* fs.stat(root).pipe(
      Effect.map((stat) => stat.type === "Directory"),
      Effect.catch(() => Effect.succeed(false)),
    )

    const files: Array<string> = isDirectory
      ? yield* fs.readDirectory(root, { recursive: true }).pipe(
          Effect.map((entries) =>
            entries
              .filter((entry) => !isIgnoredPath(entry))
              .map((entry) => (root === "." ? entry : `${root.replace(/\/$/, "")}/${entry}`)),
          ),
          Effect.catch(toToolFailure),
        )
      : [root]

    const matches: Array<{ path: string; line: number; text: string }> = []
    let totalMatches = 0
    let truncated = false

    for (const file of files) {
      if (matches.length >= maxMatches) {
        truncated = true
        break
      }

      const content = yield* fs
        .readFileString(file)
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (content === undefined) {
        continue
      }
      if (content.includes("\0") || content.length > maxFileBytes) {
        continue
      }

      const lines = content.split("\n")
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!
        if (!regex.test(line)) {
          continue
        }
        totalMatches += 1
        if (matches.length < maxMatches) {
          matches.push({
            path: file,
            line: index + 1,
            text: line.length > 500 ? `${line.slice(0, 500)}…` : line,
          })
        } else {
          truncated = true
          break
        }
      }
    }

    return {
      pattern,
      path: root,
      matches,
      totalMatches,
      truncated: truncated || totalMatches > matches.length,
    }
  }),
})
