import { stdin as input, stdout as output } from "node:process"
import { createInterface } from "node:readline/promises"

import { Agent, AgentLiveToolkit } from "@roop/agent/Agent.ts"
import type { AgentEvent } from "@roop/agent/AgentEvent.ts"
import { SessionStoreMemory } from "@roop/agent/SessionStore.ts"
import { Effect, Layer, Schema, Stream } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"

import { DeepSeekLive } from "./DeepSeek.ts"

const Now = Tool.make("now", {
  description: "Current wall-clock time as ISO-8601",
  parameters: Schema.Struct({ utc: Schema.optionalKey(Schema.Boolean) }),
  success: Schema.Struct({ iso: Schema.String }),
})

const NowToolkit = Toolkit.make(Now)

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

export const main = Effect.gen(function* () {
  const apiKey = process.env["DEEPSEEK_API_KEY"]
  if (apiKey === undefined) {
    return yield* Effect.logError("DEEPSEEK_API_KEY is not set")
  }

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

const Live = AgentLiveToolkit(NowToolkit).pipe(
  Layer.provide(DeepSeekLive(process.env["DEEPSEEK_API_KEY"] ?? "")),
  Layer.provide(SessionStoreMemory),
  Layer.provide(
    NowToolkit.toLayer({
      now: () => Effect.succeed({ iso: new Date().toISOString() }),
    }),
  ),
)

Effect.runPromise(main.pipe(Effect.provide(Live)))
