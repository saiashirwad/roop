import {
  CombinedAutocompleteProvider,
  Container,
  Editor,
  Loader,
  Markdown,
  matchesKey,
  ProcessTerminal,
  type SlashCommand,
  Text,
  TUI,
} from "@mariozechner/pi-tui"
import { AgentRpc } from "@roop/agent-rpc/AgentRpc.ts"
import { AgentRpcClientHttp } from "@roop/agent-rpc/AgentRpcHttp.ts"
import { fromSessionEvents } from "@roop/agent-rpc/Transcript.ts"
import type { AgentEvent, SessionEvent } from "@roop/agent/AgentEvents.ts"
import { cryptoWeb } from "@roop/agent/cryptoWeb.ts"
import { Cause, Clock, Crypto, Effect, FiberSet, Option, Queue, Stream } from "effect"
import { RpcClient } from "effect/unstable/rpc"

import { ensureSessionId, forkSessionRequest } from "./sessionIdentity.ts"
import { bold, cyan, dim, editorTheme, markdownTheme, red, reasoningTextStyle } from "./theme.ts"
import { renderToolCall } from "./toolViews.ts"

type Action =
  | { readonly _tag: "Submit"; readonly text: string }
  | { readonly _tag: "Interrupt" }
  | { readonly _tag: "Quit" }

const formatAgo = (timestamp: number, now: number): string => {
  const minutes = Math.round((now - timestamp) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 1_440) return `${Math.round(minutes / 60)}h ago`
  return `${Math.round(minutes / 1_440)}d ago`
}

const main = Effect.gen(function* () {
  const url = process.argv[2] ?? "http://localhost:8787/rpc"
  const runPromise = yield* FiberSet.makeRuntimePromise()
  const client = yield* RpcClient.make(AgentRpc).pipe(Effect.provide(AgentRpcClientHttp(url)))
  const caps = yield* client.Capabilities()
  const crypto = yield* Crypto.Crypto
  let sessionId: string | undefined
  let modelId: string = caps.defaultModelId
  const actions = yield* Queue.unbounded<Action>()

  const tui = new TUI(new ProcessTerminal())
  const chat = new Container()
  const editor = new Editor(tui, editorTheme)
  editor.onSubmit = (text) => {
    const prompt = text.trim()
    if (prompt.length > 0) {
      editor.setText("")
      Queue.offerUnsafe(actions, { _tag: "Submit", text: prompt })
    }
  }
  tui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+c")) {
      Queue.offerUnsafe(actions, { _tag: "Quit" })
      return { consume: true }
    }
    if (matchesKey(data, "escape")) {
      Queue.offerUnsafe(actions, { _tag: "Interrupt" })
      return { consume: true }
    }
    return undefined
  })
  const headerText = () => {
    const session = sessionId === undefined ? dim("[unsaved]") : cyan(`[${sessionId.slice(0, 8)}]`)
    return `${bold("roop")} ${dim(`— ${url}`)} ${session}\n${dim(
      `model ${modelId} · tools ${caps.tools.map((tool) => tool.name).join(", ")} · enter to send · esc to interrupt · ctrl+c to quit`,
    )}`
  }
  const header = new Text(headerText(), 0, 1)
  tui.addChild(header)
  tui.addChild(chat)
  tui.addChild(editor)
  tui.setFocus(editor)
  tui.start()
  yield* Effect.addFinalizer(() => Effect.sync(() => tui.stop()))

  const info = (text: string) => {
    chat.addChild(new Text(text, 0, 1))
    tui.requestRender()
  }

  const replaySession = (events: ReadonlyArray<SessionEvent>) => {
    chat.clear()
    const items = fromSessionEvents(events)
    for (const item of items) {
      switch (item.kind) {
        case "user":
          chat.addChild(new Text(`${cyan("❯")} ${bold(item.text)}`, 0, 1))
          break
        case "assistant":
          chat.addChild(new Markdown(item.text, 0, 0, markdownTheme))
          break
        case "reasoning":
          chat.addChild(new Markdown(item.text, 0, 0, markdownTheme, reasoningTextStyle))
          break
        case "tool":
          const toolData =
            item.isFailure === undefined
              ? { name: item.name, params: item.params, result: item.result }
              : {
                  name: item.name,
                  params: item.params,
                  result: item.result,
                  isFailure: item.isFailure,
                }
          chat.addChild(new Text(renderToolCall(toolData), 0, 0))
          break
        case "notice":
          chat.addChild(new Text(dim(item.text), 0, 0))
          break
      }
    }
  }

  const commands: Array<SlashCommand> = [
    {
      name: "models",
      description: "list models, or switch with /models <id>",
      argumentHint: "[id]",
      getArgumentCompletions: (prefix) =>
        caps.models
          .filter((model) => model.id.startsWith(prefix))
          .map((model) =>
            model.description === undefined
              ? { value: model.id, label: model.id }
              : { value: model.id, label: model.id, description: model.description },
          ),
    },
    { name: "skills", description: "list the agent's skills" },
    { name: "tools", description: "list the agent's tools" },
    { name: "sessions", description: "list saved sessions" },
    {
      name: "resume",
      description: "resume/switch to a session by ID (/resume <id>)",
      argumentHint: "<id>",
      getArgumentCompletions: (prefix) =>
        runPromise(
          client.ListSessions().pipe(
            Effect.map((sessions) =>
              sessions
                .filter(
                  (s) =>
                    s.id.startsWith(prefix) || s.title.toLowerCase().includes(prefix.toLowerCase()),
                )
                .map((s) => ({
                  value: s.id,
                  label: s.id.slice(0, 8),
                  description: s.title === "" ? "Untitled" : s.title,
                })),
            ),
            Effect.orElseSucceed(() => []),
          ),
        ),
    },
    {
      name: "fork",
      description: "fork current session into a new session (/fork [newId])",
      argumentHint: "[id]",
    },
    { name: "new", description: "start a new session" },
    { name: "help", description: "list commands" },
  ]
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, process.cwd()))
  const command = (line: string) =>
    Effect.gen(function* () {
      const [name, arg] = line.slice(1).split(/\s+/, 2)
      if (
        activePromptSessionId !== undefined &&
        (name === "resume" || name === "fork" || name === "new")
      ) {
        info(dim("busy — esc to interrupt"))
        return
      }
      switch (name) {
        case "models": {
          if (arg === undefined) {
            info(
              caps.models
                .map(
                  (model) =>
                    `${model.id === modelId ? cyan("●") : dim("○")} ${model.id}${
                      model.description === undefined ? "" : dim(` — ${model.description}`)
                    }`,
                )
                .join("\n"),
            )
          } else if (caps.models.some((model) => model.id === arg)) {
            modelId = arg
            header.setText(headerText())
            info(dim(`model → ${arg}`))
          } else {
            info(red(`unknown model: ${arg}`))
          }
          return
        }
        case "skills": {
          info(
            caps.skills.length === 0
              ? dim("no skills")
              : caps.skills
                  .map((skill) => `${bold(skill.id)} ${dim(skill.description)}`)
                  .join("\n"),
          )
          return
        }
        case "tools": {
          info(caps.tools.map((tool) => `${bold(tool.name)} ${dim(tool.description)}`).join("\n"))
          return
        }
        case "sessions": {
          const sessionsExit = yield* Effect.exit(client.ListSessions())
          const sessions =
            sessionsExit._tag === "Success"
              ? sessionsExit.value
              : (info(red("failed to list sessions")), [])
          if (sessions.length === 0) {
            info(dim("no saved sessions"))
            return
          }
          const now = yield* Clock.currentTimeMillis
          info(
            sessions
              .map((s) => {
                const marker = s.id === sessionId ? cyan("●") : dim("○")
                const time = dim(formatAgo(s.updatedAt, now))
                const titleText = s.title === "" ? dim("Untitled") : s.title
                return `${marker} ${bold(s.id.slice(0, 8))} ${dim(`(${s.id})`)} · ${time}\n  ${titleText}`
              })
              .join("\n"),
          )
          return
        }
        case "resume": {
          if (arg === undefined || arg.trim() === "") {
            info(red("usage: /resume <session-id>"))
            return
          }
          const targetPrefix = arg.trim()
          const sessionsExit = yield* Effect.exit(client.ListSessions())
          const sessions = sessionsExit._tag === "Success" ? sessionsExit.value : []
          const matched = sessions.find(
            (s) => s.id === targetPrefix || s.id.startsWith(targetPrefix),
          )
          const targetId = matched !== undefined ? matched.id : targetPrefix
          const historyResult = yield* Effect.exit(client.GetHistory({ sessionId: targetId }))
          if (historyResult._tag === "Failure") {
            const failure = Cause.findErrorOption(historyResult.cause)
            if (Option.isSome(failure) && failure.value._tag === "SessionNotFound") {
              info(red(`session not found: ${targetId}`))
            } else if (Option.isSome(failure) && failure.value._tag === "SessionFormatError") {
              info(red(`failed to read session ${targetId}: ${failure.value.message}`))
            } else {
              info(red(`failed to resume session ${targetId}: ${String(historyResult.cause)}`))
            }
            return
          }
          sessionId = targetId
          header.setText(headerText())
          replaySession(historyResult.value.events)
          info(dim(`resumed session ${targetId}`))
          tui.requestRender()
          return
        }
        case "fork": {
          const request = forkSessionRequest(sessionId, arg)
          if (request === undefined) {
            info(dim("no saved session to fork"))
            return
          }
          const forkResult = yield* Effect.exit(client.ForkSession(request))
          if (forkResult._tag === "Failure") {
            info(red(`failed to fork session: ${String(forkResult.cause)}`))
            return
          }
          sessionId = forkResult.value.id
          header.setText(headerText())
          info(dim(`forked session to ${forkResult.value.id}`))
          return
        }
        case "new": {
          sessionId = undefined
          chat.clear()
          header.setText(headerText())
          tui.requestRender()
          return
        }
        case "help": {
          info(
            commands
              .map((entry) => `${bold(`/${entry.name}`)} ${dim(entry.description ?? "")}`)
              .join("\n"),
          )
          return
        }
        default: {
          info(red(`unknown command: /${name}`))
        }
      }
    })

  const run = (prompt: string, sessionId: string) =>
    Effect.gen(function* () {
      chat.addChild(new Text(`${cyan("❯")} ${bold(prompt)}`, 0, 1))
      const loader = new Loader(tui, dim, dim, "working")
      chat.addChild(loader)
      loader.start()
      let markdown: Markdown | undefined
      let buffer = ""
      let reasoning: Markdown | undefined
      let reasoningBuffer = ""
      const calls = new Map<string, { readonly text: Text; readonly params: unknown }>()
      const tickers = new Map<string, Text>()
      const flush = () => {
        markdown = undefined
        buffer = ""
        reasoning = undefined
        reasoningBuffer = ""
      }
      const render = (event: AgentEvent) => {
        switch (event._tag) {
          case "TextDelta": {
            // Reasoning models emit reasoning first, so text after reasoning
            // opens a fresh assistant block — matching apply(), which starts a
            // new assistant item there. Plain streaming text still appends.
            if (reasoning !== undefined) {
              reasoning = undefined
              reasoningBuffer = ""
              markdown = undefined
              buffer = ""
            }
            buffer += event.delta
            if (markdown === undefined) {
              markdown = new Markdown("", 0, 0, markdownTheme)
              chat.addChild(markdown)
            }
            markdown.setText(buffer)
            return
          }
          case "ReasoningDelta": {
            reasoningBuffer += event.delta
            if (reasoning === undefined) {
              reasoning = new Markdown("", 0, 0, markdownTheme, reasoningTextStyle)
              chat.addChild(reasoning)
            }
            reasoning.setText(reasoningBuffer)
            return
          }
          case "ToolCall": {
            flush()
            const text = new Text(renderToolCall({ name: event.name, params: event.params }), 0, 0)
            calls.set(event.id, { text, params: event.params })
            chat.addChild(text)
            return
          }
          case "ToolResult": {
            const call = calls.get(event.id)
            const rendered = renderToolCall({
              name: event.name,
              params: call?.params,
              result: event.result,
              isFailure: event.isFailure,
            })
            if (call === undefined) {
              chat.addChild(new Text(rendered, 0, 0))
            } else {
              call.text.setText(rendered)
            }
            return
          }
          case "Subagent": {
            const inner = event.event
            const tickerKey = event.toolCallId ?? event.name
            let ticker = tickers.get(tickerKey)
            if (ticker === undefined) {
              ticker = new Text("", 0, 0)
              tickers.set(tickerKey, ticker)
              chat.addChild(ticker)
            }
            if (inner._tag === "ToolCall") {
              ticker.setText(
                `${dim("└")} ${renderToolCall({ name: inner.name, params: inner.params })}`,
              )
            }
            if (inner._tag === "Finish") {
              chat.removeChild(ticker)
              tickers.delete(tickerKey)
            }
            return
          }
          case "Finish": {
            flush()
            if (event.reason !== "completed") {
              chat.addChild(
                new Text(
                  red(`${event.reason}${event.message === undefined ? "" : `: ${event.message}`}`),
                  0,
                  0,
                ),
              )
            }
            return
          }
        }
      }
      yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          chat.addChild(loader)
          loader.start()
          tui.requestRender()
        }),
        () =>
          client.Prompt({ prompt, sessionId, modelId, policy: { maxTurns: 50 } }).pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                render(event)
                tui.requestRender()
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.sync(() => chat.addChild(new Text(red(Cause.pretty(cause)), 0, 0))),
            ),
          ),
        () =>
          Effect.sync(() => {
            loader.stop()
            chat.removeChild(loader)
            tui.requestRender()
          }),
      )
    })

  let activePromptSessionId: string | undefined
  yield* Stream.fromQueue(actions).pipe(
    Stream.takeWhile((action) => action._tag !== "Quit"),
    Stream.runForEach((action) => {
      switch (action._tag) {
        case "Submit": {
          if (action.text.startsWith("/")) {
            return command(action.text)
          }
          if (activePromptSessionId !== undefined) {
            const target = activePromptSessionId
            return Effect.sync(() => {
              chat.addChild(new Text(dim(`steering: ${action.text}`), 0, 0))
              tui.requestRender()
            }).pipe(
              Effect.andThen(
                Effect.forkScoped(
                  client.Steer({ sessionId: target, message: action.text }).pipe(
                    Effect.catchTag("RunNotFound", () =>
                      Effect.sync(() => {
                        chat.addChild(
                          new Text(red("cannot steer: prompt has already completed"), 0, 0),
                        )
                        tui.requestRender()
                      }),
                    ),
                    Effect.catchCause((cause) =>
                      Effect.sync(() => {
                        chat.addChild(
                          new Text(red(`steering failed: ${Cause.pretty(cause)}`), 0, 0),
                        )
                        tui.requestRender()
                      }),
                    ),
                  ),
                ),
              ),
            )
          }
          return Effect.gen(function* () {
            const promptSessionId = yield* ensureSessionId(
              sessionId,
              Effect.orDie(crypto.randomUUIDv4),
            )
            if (sessionId === undefined) {
              sessionId = promptSessionId
              header.setText(headerText())
              tui.requestRender()
            }
            activePromptSessionId = promptSessionId
            yield* Effect.forkScoped(
              run(action.text, promptSessionId).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    activePromptSessionId = undefined
                  }),
                ),
              ),
            )
          })
        }
        case "Interrupt": {
          const target = activePromptSessionId
          return target === undefined
            ? Effect.void
            : Effect.sync(() => {
                chat.addChild(new Text(dim("interrupting..."), 0, 0))
                tui.requestRender()
              }).pipe(
                Effect.andThen(
                  Effect.forkScoped(client.Interrupt({ sessionId: target }).pipe(Effect.ignore)),
                ),
              )
        }
      }
    }),
  )
})

Effect.runFork(
  Effect.scoped(main).pipe(
    Effect.provide(cryptoWeb),
    Effect.catchCause((cause) => Effect.logError(String(cause))),
    Effect.ensuring(Effect.sync(() => process.exit(0))),
  ),
)
