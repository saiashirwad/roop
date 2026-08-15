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
import type { AgentEvent } from "@roop/agent/AgentEvent.ts"
import { Effect, Queue, Stream } from "effect"
import { RpcClient } from "effect/unstable/rpc"

import { bold, cyan, dim, editorTheme, markdownTheme, red } from "./theme.ts"
import { renderToolCall } from "./toolViews.ts"

type Action =
  | { readonly _tag: "Submit"; readonly text: string }
  | { readonly _tag: "Interrupt" }
  | { readonly _tag: "Quit" }

const main = Effect.gen(function* () {
  const url = process.argv[2] ?? "http://localhost:8787/rpc"
  const client = yield* RpcClient.make(AgentRpc).pipe(Effect.provide(AgentRpcClientHttp(url)))
  const caps = yield* client.Capabilities()
  let sessionId = globalThis.crypto.randomUUID()
  let modelId = caps.defaultModelId
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
  const headerText = () =>
    `${bold("roop")} ${dim(`— ${url}`)}\n${dim(
      `model ${modelId} · tools ${caps.tools.map((tool) => tool.name).join(", ")} · enter to send · esc to interrupt · ctrl+c to quit`,
    )}`
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
    { name: "new", description: "start a new session" },
    { name: "help", description: "list commands" },
  ]
  editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, process.cwd()))
  const command = (line: string) =>
    Effect.gen(function* () {
      const [name, arg] = line.slice(1).split(/\s+/, 2)
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
        case "new": {
          sessionId = globalThis.crypto.randomUUID()
          chat.clear()
          info(dim("new session"))
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

  const run = (prompt: string) =>
    Effect.gen(function* () {
      chat.addChild(new Text(`${cyan("❯")} ${bold(prompt)}`, 0, 1))
      const loader = new Loader(tui, dim, dim, "working")
      chat.addChild(loader)
      loader.start()
      let markdown: Markdown | undefined
      let buffer = ""
      const calls = new Map<string, { readonly text: Text; readonly params: unknown }>()
      const tickers = new Map<string, Text>()
      const flush = () => {
        markdown = undefined
        buffer = ""
      }
      const render = (event: AgentEvent) => {
        switch (event._tag) {
          case "TextDelta": {
            buffer += event.delta
            if (markdown === undefined) {
              markdown = new Markdown("", 0, 0, markdownTheme)
              chat.addChild(markdown)
            }
            markdown.setText(buffer)
            return
          }
          case "ReasoningDelta": {
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
            let ticker = tickers.get(event.name)
            if (ticker === undefined) {
              ticker = new Text("", 0, 0)
              tickers.set(event.name, ticker)
              chat.addChild(ticker)
            }
            if (inner._tag === "ToolCall") {
              ticker.setText(
                `${dim("└")} ${renderToolCall({ name: inner.name, params: inner.params })}`,
              )
            }
            if (inner._tag === "Finish") {
              chat.removeChild(ticker)
              tickers.delete(event.name)
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
      yield* client.Prompt({ prompt, sessionId, modelId, maxTurns: 50 }).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            render(event)
            tui.requestRender()
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.sync(() => chat.addChild(new Text(red(String(cause)), 0, 0))),
        ),
      )
      loader.stop()
      chat.removeChild(loader)
      tui.requestRender()
    })

  let busy = false
  yield* Stream.fromQueue(actions).pipe(
    Stream.takeWhile((action) => action._tag !== "Quit"),
    Stream.runForEach((action) => {
      switch (action._tag) {
        case "Submit": {
          if (action.text.startsWith("/")) {
            return command(action.text)
          }
          if (busy) {
            return Effect.sync(() => {
              chat.addChild(new Text(dim("busy — esc to interrupt"), 0, 0))
              tui.requestRender()
            })
          }
          busy = true
          return Effect.forkScoped(
            run(action.text).pipe(Effect.ensuring(Effect.sync(() => (busy = false)))),
          )
        }
        case "Interrupt": {
          return Effect.forkScoped(client.Interrupt({ sessionId }).pipe(Effect.ignore))
        }
      }
    }),
  )
})

Effect.runFork(
  Effect.scoped(main).pipe(
    Effect.catchCause((cause) => Effect.logError(String(cause))),
    Effect.ensuring(Effect.sync(() => process.exit(0))),
  ),
)
