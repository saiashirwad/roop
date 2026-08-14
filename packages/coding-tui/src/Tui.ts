import {
  Container,
  Editor,
  Loader,
  Markdown,
  matchesKey,
  ProcessTerminal,
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
  const sessionId = crypto.randomUUID()
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
  tui.addChild(
    new Text(
      `${bold("roop")} ${dim(`— ${url}`)}\n${dim(
        `model ${caps.defaultModelId} · tools ${caps.tools.map((tool) => tool.name).join(", ")} · enter to send · esc to interrupt · ctrl+c to quit`,
      )}`,
      0,
      1,
    ),
  )
  tui.addChild(chat)
  tui.addChild(editor)
  tui.setFocus(editor)
  tui.start()
  yield* Effect.addFinalizer(() => Effect.sync(() => tui.stop()))

  const run = (prompt: string) =>
    Effect.gen(function* () {
      chat.addChild(new Text(`${cyan("❯")} ${bold(prompt)}`, 0, 1))
      const loader = new Loader(tui, dim, dim, "working")
      chat.addChild(loader)
      loader.start()
      let markdown: Markdown | undefined
      let buffer = ""
      const calls = new Map<string, { readonly text: Text; readonly params: unknown }>()
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
      yield* client.Prompt({ prompt, sessionId, maxTurns: 50 }).pipe(
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
    Effect.catchCause((cause) => Effect.sync(() => console.error(String(cause)))),
    Effect.ensuring(Effect.sync(() => process.exit(0))),
  ),
)
