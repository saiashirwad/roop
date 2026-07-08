import {
  AgentRunner,
  type AgentNotFound,
  type RunHandle,
  type SpawnAgentResult,
  type SpawnDepthExceeded,
  type SpawnLimitExceeded,
} from "@roop/core/AgentRunner.ts"
import { CurrentRun, type CurrentRunService } from "@roop/core/CurrentRun.ts"
import { definePlugin } from "@roop/core/Plugin.ts"
import { SessionLog } from "@roop/core/SessionLog.ts"
import type { SessionNotFound } from "@roop/core/SessionStore.ts"
import { ToolFailure } from "@roop/tools/failure.ts"
import {
  AwaitAgents,
  CheckAgent,
  scanSubagentRecords,
  SendToAgent,
  StopAgent,
} from "@roop/tools/orchestrate.ts"
import { isTrue } from "@roop/tools/params.ts"
import { SpawnAgent } from "@roop/tools/spawnAgent.ts"
import { Effect, Option } from "effect"
import { Toolkit } from "effect/unstable/ai"

/** Shared with pack registry / ListCapabilities. */
export const EXPLORE_DESCRIPTION =
  "Read-only codebase explorer. Use for broad questions (where is X?, how does Y work?) so the parent context stays clean. Not for edits or running commands."

const SubagentsToolkit = Toolkit.make(SpawnAgent, AwaitAgents, CheckAgent, SendToAgent, StopAgent)

type SpawnProgress = {
  readonly status: "running" | "completed" | "failed" | "interrupted"
  readonly summary: string
  readonly childSessionId: string
  readonly childRunId: string
  readonly agentId: string
}

type SpawnContext = {
  readonly preliminary: (result: SpawnProgress) => Effect.Effect<void>
}

const spawnFailure = (
  error: AgentNotFound | SpawnDepthExceeded | SpawnLimitExceeded | SessionNotFound,
): ToolFailure => {
  switch (error._tag) {
    case "AgentNotFound": {
      return { message: `Unknown subagent: ${error.agentId}`, reason: "AgentNotFound" }
    }
    case "SpawnDepthExceeded": {
      return {
        message: `Subagent nesting too deep (depth ${error.depth}, max ${error.max}).`,
        reason: "SpawnDepthExceeded",
      }
    }
    case "SpawnLimitExceeded": {
      return {
        message: `Too many live subagents (${error.count} of ${error.max}). Await or stop some before spawning more.`,
        reason: "SpawnLimitExceeded",
      }
    }
    case "SessionNotFound": {
      return { message: `Unknown session: ${error.sessionId}`, reason: "SessionNotFound" }
    }
  }
}

const settledResult = (runId: string, result: SpawnAgentResult) => ({
  runId,
  agentId: result.agentId,
  childSessionId: result.childSessionId,
  status: result.status,
  summary: result.summary,
})

/**
 * AgentRunner/SessionLog captured at layer build; CurrentRun is fiber-local
 * at call time (parent identity + depth).
 */
export const SubagentsPlugin = definePlugin({
  id: "subagents",
  description: "Spawn and orchestrate nested agents (explore, …) with isolated sessions",
  features: ["spawn", "orchestrate"],
  toolkit: SubagentsToolkit,
  handlers: SubagentsToolkit.toLayer(
    Effect.gen(function* () {
      const runner = yield* AgentRunner
      const log = yield* SessionLog

      const requireCurrentRun = (tool: string): Effect.Effect<CurrentRunService, ToolFailure> =>
        Effect.serviceOption(CurrentRun).pipe(
          Effect.flatMap((current) =>
            Option.isSome(current)
              ? Effect.succeed(current.value)
              : Effect.fail({
                  message: `${tool} requires an active parent run (CurrentRun missing).`,
                  reason: "NoCurrentRun",
                } satisfies ToolFailure),
          ),
        )

      return {
        spawnAgent: (
          params: {
            readonly agent: string
            readonly task: string
            readonly background?: boolean | null | undefined
            readonly note?: string | null | undefined
          },
          context: SpawnContext,
        ) =>
          Effect.gen(function* () {
            const current = yield* requireCurrentRun("spawnAgent")

            const handle = yield* runner
              .spawn({
                agentId: params.agent,
                task: params.task,
                parentToolCallId: crypto.randomUUID(),
                model: current.model,
                parentSessionId: current.sessionId,
                parentRunId: current.runId,
                depth: current.depth,
                reportProgress: (progress) => context.preliminary(progress),
              })
              .pipe(Effect.mapError(spawnFailure))

            if (isTrue(params.background)) {
              return {
                status: "running" as const,
                summary: "",
                childSessionId: handle.sessionId,
                childRunId: handle.runId,
                agentId: handle.agentId,
              }
            }

            return yield* handle.await
          }),

        awaitAgents: (params: {
          readonly runIds: ReadonlyArray<string>
          readonly mode?: "any" | "all" | null | undefined
        }) =>
          Effect.gen(function* () {
            const mode = params.mode === "any" ? "any" : "all"

            const known: Array<{ readonly runId: string; readonly handle: RunHandle }> = []
            const unknown: Array<string> = []
            for (const runId of params.runIds) {
              const handle = yield* runner.getRun(runId)
              if (Option.isSome(handle)) {
                known.push({ runId, handle: handle.value })
              } else {
                unknown.push(runId)
              }
            }

            // Unknown ids settle as per-id failures, not a whole-call failure.
            const unknownResults = unknown.map((runId) => ({
              runId,
              agentId: "",
              childSessionId: "",
              status: "failed" as const,
              summary: `Unknown runId: ${runId} — no run with this id was spawned here.`,
            }))

            if (mode === "any") {
              if (unknownResults.length > 0 || known.length === 0) {
                return {
                  results: unknownResults,
                  pending: known.map((entry) => entry.runId),
                }
              }
              const first = yield* Effect.raceAll(
                known.map(({ handle, runId }) =>
                  handle.await.pipe(Effect.map((result) => settledResult(runId, result))),
                ),
              )
              return {
                results: [first],
                pending: known.map((entry) => entry.runId).filter((id) => id !== first.runId),
              }
            }

            const settled = yield* Effect.forEach(
              known,
              ({ handle, runId }) =>
                handle.await.pipe(Effect.map((result) => settledResult(runId, result))),
              { concurrency: "unbounded" },
            )
            return { results: [...unknownResults, ...settled], pending: [] }
          }),

        checkAgent: (params: { readonly runId: string }) =>
          Effect.gen(function* () {
            const handle = yield* runner.getRun(params.runId)
            if (Option.isNone(handle)) {
              return yield* Effect.fail({
                message: `Unknown runId: ${params.runId}`,
                reason: "RunNotFound",
              } satisfies ToolFailure)
            }

            const session = yield* log
              .get(handle.value.sessionId)
              .pipe(Effect.mapError(spawnFailure))
            const activity = scanSubagentRecords(session.records)

            return {
              runId: handle.value.runId,
              agentId: handle.value.agentId,
              childSessionId: handle.value.sessionId,
              running: activity.running,
              lastText: activity.lastText,
              eventCount: activity.eventCount,
            }
          }),

        sendToAgent: (
          params: { readonly sessionId: string; readonly prompt: string },
          context: SpawnContext,
        ) =>
          Effect.gen(function* () {
            const current = yield* requireCurrentRun("sendToAgent")

            // Only subagent sessions carry agentId (used to pick the spec).
            const session = yield* log.get(params.sessionId).pipe(Effect.mapError(spawnFailure))
            if (session.agentId === undefined) {
              return yield* Effect.fail({
                message: `Session ${params.sessionId} is not a subagent session.`,
                reason: "NotASubagentSession",
              } satisfies ToolFailure)
            }

            // A second live run would interleave appends into the same session log.
            if (scanSubagentRecords(session.records).running) {
              return yield* Effect.fail({
                message: `Session ${params.sessionId} still has a live run — await or stop it before sending a follow-up.`,
                reason: "SessionBusy",
              } satisfies ToolFailure)
            }

            const handle = yield* runner
              .spawn({
                agentId: session.agentId,
                task: params.prompt,
                parentToolCallId: crypto.randomUUID(),
                model: current.model,
                parentSessionId: current.sessionId,
                parentRunId: current.runId,
                sessionId: params.sessionId,
                depth: current.depth,
                reportProgress: (progress) => context.preliminary(progress),
              })
              .pipe(Effect.mapError(spawnFailure))

            return yield* handle.await
          }),

        stopAgent: (params: { readonly runId: string }) =>
          Effect.gen(function* () {
            const handle = yield* runner.getRun(params.runId)
            if (Option.isNone(handle)) {
              return { runId: params.runId, stopped: false }
            }
            yield* handle.value.interrupt
            return { runId: params.runId, stopped: true }
          }),
      }
    }),
  ),
  prompt: [
    {
      id: "subagents/when",
      content: `## Subagents

You can call spawnAgent to run a specialized worker in an isolated session.

Available agents:
- explore — ${EXPLORE_DESCRIPTION}

When to use explore:
- Broad "where / how / find" codebase questions that need many reads/greps
- When intermediate tool noise would bloat the main conversation

When not to use:
- Single-file reads you can do yourself with readFile/grep
- Edits, tests, or shell commands (explore is read-only)

Orchestration:
- spawnAgent with background: true returns immediately (status "running") with a childRunId and childSessionId; the worker keeps going while you do other work.
- awaitAgents { runIds } collects background results — mode "all" (default) waits for every id, mode "any" returns on the first settlement and lists the rest in pending.
- checkAgent { runId } is a non-blocking peek: running flag, last assistant text, event count.
- sendToAgent { sessionId, prompt } sends a follow-up to an existing child session and waits for its reply.
- stopAgent { runId } interrupts a child you no longer need.

Limits:
- Nesting caps at 3 levels and each run may have at most 8 live children; spawns beyond either limit return a tool failure — await or stop children before spawning more.
- Children die with your run: unfinished background children are interrupted when your run ends, so awaitAgents (or stopAgent) every background runId before you finish answering.

Pass a self-contained task string; the subagent does not see full chat history.
Use the subagent summary when you continue answering the user.`,
    },
  ],
})
