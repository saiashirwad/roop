import type { SessionRecord } from "@roop/core/SessionStore.ts"
import { Schema } from "effect"
import { Tool } from "effect/unstable/ai"

import { ToolFailure } from "./failure.ts"
import { llmOptional } from "./params.ts"
import { SpawnAgentSuccess } from "./spawnAgent.ts"

const SettledRun = Schema.Struct({
  runId: Schema.String,
  agentId: Schema.String,
  childSessionId: Schema.String,
  status: Schema.Literals(["completed", "failed", "interrupted"]),
  summary: Schema.String,
})

export const AwaitAgents = Tool.make("awaitAgents", {
  description:
    'Wait for background subagents to settle. mode "all" (default) blocks until every runId is done; "any" returns on the first settlement and lists the rest in pending. Unknown runIds come back as failed results instead of failing the call.',
  parameters: Schema.Struct({
    runIds: Schema.Array(Schema.String).annotate({
      description: "Run ids to collect (childRunId values from spawnAgent).",
    }),
    mode: llmOptional(
      Schema.Literals(["any", "all"]).annotate({
        description: 'Default "all". "any" returns on the first settled run.',
      }),
    ),
  }),
  success: Schema.Struct({
    results: Schema.Array(SettledRun),
    pending: Schema.Array(Schema.String),
  }),
  failure: ToolFailure,
  failureMode: "return",
})

export const CheckAgent = Tool.make("checkAgent", {
  description:
    "Non-blocking peek at a subagent run: whether it is still running, its last assistant text, and how many events its session holds.",
  parameters: Schema.Struct({
    runId: Schema.String.annotate({
      description: "Run id to inspect (childRunId from spawnAgent).",
    }),
  }),
  success: Schema.Struct({
    runId: Schema.String,
    agentId: Schema.String,
    childSessionId: Schema.String,
    running: Schema.Boolean,
    lastText: Schema.String,
    eventCount: Schema.Number,
  }),
  failure: ToolFailure,
  failureMode: "return",
})

export const SendToAgent = Tool.make("sendToAgent", {
  description:
    "Send a follow-up prompt to an existing subagent session and wait for its reply. The child resumes with its full prior history.",
  parameters: Schema.Struct({
    sessionId: Schema.String.annotate({
      description: "Child session id (childSessionId from spawnAgent).",
    }),
    prompt: Schema.String.annotate({
      description: "Follow-up instructions for the subagent.",
    }),
  }),
  success: SpawnAgentSuccess,
  failure: ToolFailure,
  failureMode: "return",
})

export const StopAgent = Tool.make("stopAgent", {
  description:
    "Interrupt a running subagent (and any of its children). stopped is false when the runId is unknown.",
  parameters: Schema.Struct({
    runId: Schema.String.annotate({
      description: "Run id to stop (childRunId from spawnAgent).",
    }),
  }),
  success: Schema.Struct({
    runId: Schema.String,
    stopped: Schema.Boolean,
  }),
  failure: ToolFailure,
  failureMode: "return",
})

export const LAST_TEXT_MAX_LENGTH = 500

export type SubagentActivity = {
  readonly running: boolean
  readonly lastText: string
  readonly eventCount: number
}

export const scanSubagentRecords = (records: ReadonlyArray<SessionRecord>): SubagentActivity => {
  let running = false
  let eventCount = 0
  let lastText = ""
  let currentText = ""

  for (const record of records) {
    if (record.entry._tag !== "Agent") {
      continue
    }
    eventCount += 1
    const event = record.entry.event
    if (event._tag === "TextDelta") {
      currentText += event.delta
      continue
    }
    if (currentText.trim().length > 0) {
      lastText = currentText
    }
    currentText = ""
    switch (event._tag) {
      case "RunStarted": {
        running = true
        break
      }
      case "RunCompleted":
      case "RunFailed":
      case "RunInterrupted": {
        running = false
        break
      }
      default: {
        break
      }
    }
  }

  if (currentText.trim().length > 0) {
    lastText = currentText
  }

  const trimmed = lastText.trim()
  return {
    running,
    lastText:
      trimmed.length > LAST_TEXT_MAX_LENGTH
        ? `${trimmed.slice(0, LAST_TEXT_MAX_LENGTH)}…`
        : trimmed,
    eventCount,
  }
}
