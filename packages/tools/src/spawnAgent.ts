import { Schema } from "effect"
import { Tool } from "effect/unstable/ai"

import { ToolFailure } from "./failure.ts"
import { llmOptional } from "./params.ts"

export const SpawnAgentSuccess = Schema.Struct({
  status: Schema.Literals(["running", "completed", "failed", "interrupted"]),
  summary: Schema.String,
  childSessionId: Schema.String,
  childRunId: Schema.String,
  agentId: Schema.String,
})

export const SpawnAgent = Tool.make("spawnAgent", {
  description:
    "Run a specialized subagent on a focused task in an isolated session. Prefer for open-ended codebase exploration so intermediate tool noise stays out of the main conversation. Available agents are listed in the system prompt / capabilities.",
  parameters: Schema.Struct({
    agent: Schema.String.annotate({
      description: 'Subagent id, e.g. "explore"',
    }),
    task: Schema.String.annotate({
      description:
        "Clear instructions for the subagent. Include enough context; it does not see the full parent chat.",
    }),
    background: llmOptional(
      Schema.Boolean.annotate({
        description:
          "Run in the background and return immediately; collect later with awaitAgents.",
      }),
    ),
    note: llmOptional(
      Schema.String.annotate({
        description: "Optional short note (ignored by runtime).",
      }),
    ),
  }),
  success: SpawnAgentSuccess,
  failure: ToolFailure,
  failureMode: "return",
})
