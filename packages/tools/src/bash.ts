import { Effect, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

import { ToolFailure } from "./failure.ts"
import { llmOptional, nonEmptyString } from "./params.ts"
import { runProcess } from "./process.ts"

export const Bash = Tool.make("bash", {
  description:
    "Run a shell command in the workspace. Returns stdout, stderr, and exit code. Non-zero exit codes are returned as results, not failures.",
  parameters: Schema.Struct({
    command: Schema.String.annotate({
      description: "Shell command to run, e.g. pnpm test or ls src",
    }),
    cwd: llmOptional(
      Schema.String.annotate({
        description:
          "Working directory relative to the workspace root. Defaults to the workspace root.",
      }),
    ),
  }),
  success: Schema.Struct({
    command: Schema.String,
    cwd: Schema.String,
    exitCode: Schema.Number,
    stdout: Schema.String,
    stderr: Schema.String,
    stdoutTruncated: Schema.Boolean,
    stderrTruncated: Schema.Boolean,
  }),
  failure: ToolFailure,
  failureMode: "return",
})

export const bashHandlers = (spawner: ChildProcessSpawner["Service"]) => ({
  bash: Effect.fn("tools/bash")(function* ({
    command,
    cwd,
  }: {
    command: string
    cwd?: string | null | undefined
  }) {
    const workingDirectory = nonEmptyString(cwd) ?? "."
    const result = yield* runProcess(spawner, "sh", ["-c", command], workingDirectory)

    return {
      command,
      cwd: workingDirectory,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      stdoutTruncated: result.stdoutTruncated,
      stderrTruncated: result.stderrTruncated,
    }
  }),
})
