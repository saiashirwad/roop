import { stdin as input, stdout as output } from "node:process"
import { createInterface } from "node:readline/promises"

import { NodeRuntime } from "@effect/platform-node"
import { AgentRpc } from "@roop/agent-rpc/AgentRpc.ts"
import { AgentRpcClientHttp } from "@roop/agent-rpc/AgentRpcHttp.ts"
import type { AgentEvent } from "@roop/agent/AgentEvent.ts"
import { Effect, Layer, Stream } from "effect"
import { RpcClient } from "effect/unstable/rpc"

import { server } from "./Server.ts"

const render = (event: AgentEvent): string | undefined => {
  switch (event._tag) {
    case "TextDelta": {
      return event.delta
    }
    case "ToolCall": {
      return `\n> ${event.name}(${JSON.stringify(event.params)})`
    }
    case "ToolResult": {
      return event.isFailure
        ? `\n✗ ${event.name} ${JSON.stringify(event.result)}`
        : `\n✓ ${event.name}`
    }
    case "Finish": {
      return event.reason === "failed" ? `\n! ${event.message}` : "\n"
    }
    default: {
      return undefined
    }
  }
}

const client = (url: string) =>
  Effect.gen(function* () {
    const api = yield* RpcClient.make(AgentRpc).pipe(Effect.provide(AgentRpcClientHttp(url)))
    const caps = yield* api.Capabilities()
    yield* Effect.logInfo(
      `connected to ${url} — model ${caps.defaultModelId}, tools: ${caps.tools.map((tool) => tool.name).join(", ")}`,
    )
    const lines = createInterface({ input, output })
    yield* Stream.runForEach(
      Stream.fromAsyncIterable(lines, () => Effect.die("stdin failed")),
      (line) =>
        Effect.gen(function* () {
          const prompt = line.trim()
          if (prompt.length === 0) return
          yield* Stream.runForEach(api.Prompt({ prompt }), (event) =>
            Effect.sync(() => {
              const rendered = render(event)
              if (rendered !== undefined) output.write(rendered)
            }),
          )
          output.write("\n\n")
        }),
    )
  })

const [mode, arg] = process.argv.slice(2)

if (mode === "server") {
  const apiKey = process.env["DEEPSEEK_API_KEY"]
  if (apiKey === undefined) {
    console.error("DEEPSEEK_API_KEY is not set")
    process.exit(1)
  }
  const port = arg === undefined ? 8787 : Number(arg)
  const root = process.env["HARNESS_ROOT"] ?? process.cwd()
  NodeRuntime.runMain(Layer.launch(server({ port, root, apiKey })))
} else if (mode === "client") {
  NodeRuntime.runMain(Effect.scoped(client(arg ?? "http://localhost:8787/rpc")))
} else {
  console.log("usage: cli server [port] | cli client [url]")
}
