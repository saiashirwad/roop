import { stdin as input, stdout as output } from "node:process"
import { createInterface } from "node:readline/promises"

import { NodeHttpClient } from "@effect/platform-node"
import { Agent } from "@roop/agent/Agent.ts"
import type { AgentEvent } from "@roop/agent/AgentEvent.ts"
import { AgentPlugins, Plugin } from "@roop/agent/Plugin.ts"
import { cryptoWeb } from "@roop/agent/cryptoWeb.ts"
import { SessionStoreMemory } from "@roop/agent/SessionStore.ts"
import { OpenAiCompatible } from "@roop/plugin-openai/OpenAiCompatible.ts"
import { Effect, Layer, Schema, Stream } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"

const NowToolkit = Toolkit.make(
  Tool.make("now", {
    description: "Current wall-clock time as ISO-8601",
    parameters: Schema.Struct({ utc: Schema.optionalKey(Schema.Boolean) }),
    success: Schema.Struct({ iso: Schema.String }),
  }),
)

const now = Plugin({
  name: "now",
  toolkit: NowToolkit,
  handlers: NowToolkit.toLayer({
    now: () => Effect.succeed({ iso: new Date().toISOString() }),
  }),
})

const render = (event: AgentEvent): string | undefined => {
  switch (event._tag) {
    case "TextDelta": {
      return event.delta
    }
    case "ToolCall": {
      return `\n> ${event.name}(${JSON.stringify(event.params)})`
    }
    case "ToolResult": {
      return event.isFailure ? `\n✗ ${event.name}` : `\n✓ ${event.name}`
    }
    case "Finish": {
      return event.reason === "failed" ? `\n! ${event.message}` : "\n"
    }
    default: {
      return undefined
    }
  }
}

const main = Effect.gen(function* () {
  const agent = yield* Agent
  const lines = createInterface({ input, output })

  yield* Stream.runForEach(
    Stream.fromAsyncIterable(lines, () => Effect.die("stdin failed")),
    (line) =>
      Effect.gen(function* () {
        const prompt = line.trim()
        if (prompt.length === 0) return
        yield* Stream.runForEach(agent.prompt({ prompt }), (event) =>
          Effect.sync(() => {
            const rendered = render(event)
            if (rendered !== undefined) output.write(rendered)
          }),
        )
        output.write("\n\n")
      }),
  )
})

const apiKey = process.env["DEEPSEEK_API_KEY"]
if (apiKey === undefined) {
  console.error("DEEPSEEK_API_KEY is not set")
  process.exit(1)
}

const deepseek = OpenAiCompatible({
  name: "deepseek",
  apiUrl: "https://api.deepseek.com",
  apiKey,
  models: [{ id: "deepseek-chat", description: "DeepSeek V3 via the OpenAI-compatible API" }],
})

const Live = AgentPlugins([deepseek, now]).pipe(
  Layer.provide(SessionStoreMemory),
    Layer.provide(cryptoWeb),
  Layer.provide(NodeHttpClient.layerUndici),
)

Effect.runPromise(main.pipe(Effect.provide(Live)))
