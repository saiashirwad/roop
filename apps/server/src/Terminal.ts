import type { AgentEvent } from "@roop/core/AgentEvent.ts"
import { App } from "@roop/core/App.ts"
import { AgentClient } from "@roop/rpc/AgentClient.ts"
import { Effect, Layer, Stream, Terminal } from "effect"
import { Prompt as CliPrompt } from "effect/unstable/cli"

import { makeMarkdownWriter } from "./markdown.ts"
import { formatToolCall, formatToolResult } from "./toolView.ts"

const style = {
  gray: (text: string) => `\x1b[90m${text}\x1b[0m`,
  cyan: (text: string) => `\x1b[36m${text}\x1b[0m`,
  green: (text: string) => `\x1b[32m${text}\x1b[0m`,
  red: (text: string) => `\x1b[31m${text}\x1b[0m`,
  yellow: (text: string) => `\x1b[33m${text}\x1b[0m`,
}

/** Per-run event renderer; keeps tool/status lines from gluing onto streamed text. */
const makeRenderer = (terminal: Terminal.Terminal) => {
  const markdown = makeMarkdownWriter()
  let atLineStart = true
  let streaming: "reasoning" | "text" | undefined

  const show = (text: string) =>
    Effect.suspend(() => {
      if (text.length === 0) {
        return Effect.void
      }
      atLineStart = text.endsWith("\n")
      return terminal.display(text)
    })

  const breakLine = Effect.suspend(() => (atLineStart ? Effect.void : show("\n")))

  return Effect.fnUntraced(function* (event: AgentEvent) {
    if (event._tag !== "TextDelta" && event._tag !== "ReasoningDelta") {
      yield* show(markdown.flush())
      yield* breakLine
      streaming = undefined
    }
    switch (event._tag) {
      case "RunStarted": {
        yield* show(style.gray(`session ${event.sessionId} run ${event.runId}\n`))
        break
      }
      case "ReasoningDelta": {
        if (streaming === "text") {
          yield* show(markdown.flush())
          yield* breakLine
        }
        streaming = "reasoning"
        yield* show(style.gray(event.delta))
        break
      }
      case "TextDelta": {
        if (streaming === "reasoning") {
          yield* breakLine
        }
        streaming = "text"
        yield* show(markdown.write(event.delta))
        break
      }
      case "ToolCall": {
        yield* show(
          `${style.cyan(`→ ${event.name}`)} ${style.gray(formatToolCall(event.name, event.params))}\n`,
        )
        break
      }
      case "ToolProgress": {
        yield* show(
          style.gray(`… ${event.name} ${formatToolResult(event.name, event.result, false)}\n`),
        )
        break
      }
      case "ToolResult": {
        const mark = event.isFailure ? style.red("✗") : style.green("✓")
        const summary = formatToolResult(event.name, event.result, event.isFailure)
        yield* show(
          `${mark} ${event.name} ${event.isFailure ? style.red(summary) : style.gray(summary)}\n`,
        )
        break
      }
      case "SubagentStarted": {
        yield* show(
          style.cyan(
            `↳ subagent ${event.agentId} session ${event.childSessionId} run ${event.childRunId}\n`,
          ),
        )
        break
      }
      case "SubagentCompleted": {
        const mark =
          event.status === "completed"
            ? style.green("✓")
            : event.status === "interrupted"
              ? style.yellow("■")
              : style.red("✗")
        yield* show(`${mark} subagent ${event.agentId} ${event.status} (${event.childSessionId})\n`)
        break
      }
      case "RunCompleted": {
        yield* show("\n")
        break
      }
      case "RunFailed": {
        yield* show(`${event.message}\n`)
        break
      }
      case "RunInterrupted": {
        yield* show(style.yellow(`interrupted ${event.runId}\n`))
        break
      }
    }
  })
}

const readLine = CliPrompt.text({ message: "" }).pipe(
  Effect.map((text): { readonly _tag: "line"; readonly text: string } => ({
    _tag: "line",
    text,
  })),
  Effect.catchIf(Terminal.isQuitError, () => Effect.succeed({ _tag: "quit" as const })),
)

const terminalRun = Effect.gen(function* () {
  const terminal = yield* Terminal.Terminal
  const client = yield* AgentClient
  let activeSessionId: string | undefined
  let activeRunId: string | undefined

  while (true) {
    const input = yield* readLine
    if (input._tag === "quit") {
      break
    }

    const userPrompt = input.text
    const trimmed = userPrompt.trim()

    if (trimmed === "exit") {
      break
    }

    if (trimmed === "/new") {
      activeSessionId = undefined
      yield* terminal.display(style.gray("new session on next prompt\n"))
      continue
    }

    if (trimmed === "/session") {
      yield* terminal.display(
        style.gray(activeSessionId === undefined ? "no active session\n" : `${activeSessionId}\n`),
      )
      continue
    }

    if (trimmed === "/caps" || trimmed === "/capabilities") {
      const caps = yield* client.ListCapabilities()
      const pluginLines = caps.plugins
        .map((plugin) => {
          const toolNames = plugin.tools.map((tool) => tool.name).join(", ")
          const features =
            plugin.features !== undefined && plugin.features.length > 0
              ? ` [${plugin.features.join(", ")}]`
              : ""
          return `  ${plugin.id}${features}: ${toolNames === "" ? "(no tools)" : toolNames}`
        })
        .join("\n")
      const modelLines = caps.models
        .map((model) => {
          const effort =
            model.settings.effort !== undefined
              ? ` effort=[${model.settings.effort.levels.join("|")}]`
              : ""
          return `  ${model.id === caps.defaultModelId ? "*" : " "} ${model.id} — ${model.name}${effort}`
        })
        .join("\n")
      const defaultModel = caps.models.find((model) => model.id === caps.defaultModelId)
      yield* terminal.display(
        style.gray(
          `default: ${defaultModel === undefined ? caps.defaultModelId : `${defaultModel.provider}/${defaultModel.name} (${caps.defaultModelId})`}\n` +
            `models:\n${modelLines === "" ? "  (none)\n" : `${modelLines}\n`}` +
            `session: store=${caps.sessionStore} hub=${caps.sessionHub} search=${caps.sessionSearch}\n` +
            `plugins:\n${pluginLines === "" ? "  (none)\n" : `${pluginLines}\n`}` +
            `tools: ${caps.tools.map((t) => t.name).join(", ")}\n` +
            `features: ${caps.features.join(", ")}\n`,
        ),
      )
      continue
    }

    if (trimmed.startsWith("/search ")) {
      const query = trimmed.slice("/search ".length).trim()
      yield* client
        .SearchSessions({ query })
        .pipe(
          Stream.runForEach((summary) =>
            terminal.display(
              style.gray(
                `${summary.id}  ${summary.title ?? "(untitled)"}  (${summary.recordCount} records)\n`,
              ),
            ),
          ),
        )
      continue
    }

    if (trimmed === "/stop" || trimmed === "/interrupt") {
      if (activeRunId === undefined) {
        yield* terminal.display(style.gray("no active run\n"))
        continue
      }
      yield* client
        .Interrupt({ runId: activeRunId })
        .pipe(
          Effect.catchTag("RunNotFound", () =>
            terminal.display(style.gray(`run not found: ${activeRunId}\n`)),
          ),
        )
      continue
    }

    if (trimmed.startsWith("/resume ")) {
      const sessionId = trimmed.slice("/resume ".length).trim()
      if (sessionId.length === 0) {
        yield* terminal.display("usage: /resume <sessionId>\n")
        continue
      }
      activeSessionId = sessionId
      yield* terminal.display(style.gray(`will resume ${sessionId}\n`))
      continue
    }

    const renderEvent = makeRenderer(terminal)
    yield* client
      .RunPrompt({
        prompt: userPrompt,
        ...(activeSessionId !== undefined ? { sessionId: activeSessionId } : {}),
      })
      .pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (event._tag === "RunStarted") {
              activeSessionId = event.sessionId
              activeRunId = event.runId
            }
            if (
              event._tag === "RunCompleted" ||
              event._tag === "RunFailed" ||
              event._tag === "RunInterrupted"
            ) {
              activeRunId = undefined
            }
            yield* renderEvent(event)
          }),
        ),
      )
  }
}).pipe(Effect.catchIf(Terminal.isQuitError, () => Effect.void))

export const TerminalAppLive = Layer.effect(
  App,
  Effect.gen(function* () {
    const context = yield* Effect.context<Effect.Services<typeof terminalRun>>()
    return App.of({
      run: terminalRun.pipe(Effect.provideContext(context)),
    })
  }),
)
