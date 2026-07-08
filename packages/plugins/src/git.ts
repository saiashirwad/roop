import { definePlugin } from "@roop/core/Plugin.ts"
import { GitDiff, GitLog, GitStatus, gitHandlers } from "@roop/tools/git.ts"
import { Effect } from "effect"
import { Toolkit } from "effect/unstable/ai"
import { ChildProcessSpawner } from "effect/unstable/process"

const GitToolkit = Toolkit.make(GitStatus, GitDiff, GitLog)

/** Read-only git status/diff/log. Mutating git stays out until policies exist. */
export const GitPlugin = definePlugin({
  id: "git",
  description: "Read-only git: tools for status/diff/log",
  features: ["status", "diff", "log"],
  toolkit: GitToolkit,
  handlers: GitToolkit.toLayer(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      return gitHandlers(spawner)
    }),
  ),
  prompt: [
    {
      id: "git/prefer-tools",
      content:
        "For repository inspection, prefer gitStatus, gitDiff, and gitLog over bash. Do not use bash for routine git status/diff/log. Mutating git (commit, push, reset, force) is not provided by these tools — only do that via bash if the user explicitly asks.",
    },
  ],
})
