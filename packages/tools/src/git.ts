import { Effect, Schema } from "effect"
import { Tool } from "effect/unstable/ai"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

import { ToolFailure } from "./failure.ts"
import { isTrue, llmOptional, nonEmptyString } from "./params.ts"
import { runProcess } from "./process.ts"

const defaultLogCount = 10
const maxLogCount = 50

export const GitStatus = Tool.make("gitStatus", {
  description:
    "Show git branch and working tree status (porcelain). Prefer this over bash for git status.",
  parameters: Schema.Struct({
    cwd: llmOptional(
      Schema.String.annotate({
        description:
          "Working directory relative to the workspace root. Defaults to the workspace root.",
      }),
    ),
  }),
  success: Schema.Struct({
    cwd: Schema.String,
    exitCode: Schema.Number,
    branchLine: Schema.String,
    porcelain: Schema.String,
    stdoutTruncated: Schema.Boolean,
    stderr: Schema.String,
    stderrTruncated: Schema.Boolean,
  }),
  failure: ToolFailure,
  failureMode: "return",
})

export const GitDiff = Tool.make("gitDiff", {
  description:
    "Show git diff for unstaged or staged changes. Prefer this over bash for inspecting diffs.",
  parameters: Schema.Struct({
    staged: llmOptional(
      Schema.Boolean.annotate({
        description: "If true, show staged changes (--staged). Defaults to false (worktree).",
      }),
    ),
    path: llmOptional(
      Schema.String.annotate({
        description: "Optional path to limit the diff (file or directory relative to cwd).",
      }),
    ),
    cwd: llmOptional(
      Schema.String.annotate({
        description:
          "Working directory relative to the workspace root. Defaults to the workspace root.",
      }),
    ),
  }),
  success: Schema.Struct({
    cwd: Schema.String,
    staged: Schema.Boolean,
    path: Schema.optionalKey(Schema.String),
    exitCode: Schema.Number,
    diff: Schema.String,
    stdoutTruncated: Schema.Boolean,
    stderr: Schema.String,
    stderrTruncated: Schema.Boolean,
  }),
  failure: ToolFailure,
  failureMode: "return",
})

export const GitLog = Tool.make("gitLog", {
  description:
    "Show recent commits as one-line summaries. Prefer this over bash for git log history.",
  parameters: Schema.Struct({
    maxCount: llmOptional(
      Schema.Number.annotate({
        description: `Number of commits to show (default ${defaultLogCount}, max ${maxLogCount}).`,
      }),
    ),
    cwd: llmOptional(
      Schema.String.annotate({
        description:
          "Working directory relative to the workspace root. Defaults to the workspace root.",
      }),
    ),
  }),
  success: Schema.Struct({
    cwd: Schema.String,
    maxCount: Schema.Number,
    exitCode: Schema.Number,
    log: Schema.String,
    stdoutTruncated: Schema.Boolean,
    stderr: Schema.String,
    stderrTruncated: Schema.Boolean,
  }),
  failure: ToolFailure,
  failureMode: "return",
})

const resolveCwd = (cwd: string | null | undefined): string => nonEmptyString(cwd) ?? "."

const runGit = (
  spawner: ChildProcessSpawner["Service"],
  args: ReadonlyArray<string>,
  cwd: string,
) => runProcess(spawner, "git", args, cwd)

const clampLogCount = (maxCount: number | null | undefined): number => {
  if (maxCount === null || maxCount === undefined || !Number.isFinite(maxCount)) {
    return defaultLogCount
  }
  const n = Math.floor(maxCount)
  if (n < 1) {
    return 1
  }
  if (n > maxLogCount) {
    return maxLogCount
  }
  return n
}

export const gitHandlers = (spawner: ChildProcessSpawner["Service"]) => ({
  gitStatus: Effect.fn("tools/git/status")(function* ({
    cwd,
  }: {
    cwd?: string | null | undefined
  }) {
    const workingDirectory = resolveCwd(cwd)
    const result = yield* runGit(spawner, ["status", "--porcelain=v1", "-b"], workingDirectory)

    const lines = result.stdout.split("\n")
    const branchLine = lines[0]?.startsWith("## ") ? lines[0] : ""
    const porcelain = (branchLine.length > 0 ? lines.slice(1).join("\n") : result.stdout).replace(
      /^\n+/,
      "",
    )

    return {
      cwd: workingDirectory,
      exitCode: result.exitCode,
      branchLine,
      porcelain,
      stdoutTruncated: result.stdoutTruncated,
      stderr: result.stderr,
      stderrTruncated: result.stderrTruncated,
    }
  }),

  gitDiff: Effect.fn("tools/git/diff")(function* ({
    staged,
    path,
    cwd,
  }: {
    staged?: boolean | null | undefined
    path?: string | null | undefined
    cwd?: string | null | undefined
  }) {
    const workingDirectory = resolveCwd(cwd)
    const useStaged = isTrue(staged)
    const pathFilter = nonEmptyString(path)
    const args = ["diff"]
    if (useStaged) {
      args.push("--staged")
    }
    if (pathFilter !== undefined) {
      args.push("--", pathFilter)
    }

    const result = yield* runGit(spawner, args, workingDirectory)

    return {
      cwd: workingDirectory,
      staged: useStaged,
      ...(pathFilter !== undefined ? { path: pathFilter } : {}),
      exitCode: result.exitCode,
      diff: result.stdout,
      stdoutTruncated: result.stdoutTruncated,
      stderr: result.stderr,
      stderrTruncated: result.stderrTruncated,
    }
  }),

  gitLog: Effect.fn("tools/git/log")(function* ({
    maxCount,
    cwd,
  }: {
    maxCount?: number | null | undefined
    cwd?: string | null | undefined
  }) {
    const workingDirectory = resolveCwd(cwd)
    const count = clampLogCount(maxCount)
    const result = yield* runGit(
      spawner,
      ["log", "--oneline", `-n${String(count)}`],
      workingDirectory,
    )

    return {
      cwd: workingDirectory,
      maxCount: count,
      exitCode: result.exitCode,
      log: result.stdout,
      stdoutTruncated: result.stdoutTruncated,
      stderr: result.stderr,
      stderrTruncated: result.stderrTruncated,
    }
  }),
})

export const clampGitLogCount = clampLogCount
