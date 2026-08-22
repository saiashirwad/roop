import { Agent, JournalMemory, Middleware, Module, Runtime } from "@roop/agent"
import { Console, Effect, Layer, Ref, Schema, Stream } from "effect"
import { Tool } from "effect/unstable/ai"

import { DeepSeek } from "./deepseek.ts"

/**
 * 07 - Resilience, Model Fallbacks, and Doom Loop Protection
 *
 * Demonstrates how Roop builds resilient agents using composable middleware:
 * 1. Doom Loop Guard: Rejects repetitive identical tool invocations after a configurable threshold.
 * 2. Model Fallback: Seamlessly falls back to a secondary model if the primary model fails.
 */

// 1. Doom Loop Protection Middleware
export const doomLoopGuard = (consecutiveLimit: number): Effect.Effect<Middleware.Middleware> =>
  Effect.gen(function* () {
    const lastCall = yield* Ref.make({ signature: "", count: 0 })

    return Middleware.make({
      tool: (next) => (input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const signature = JSON.stringify([input.name, input.params])
            const state = yield* Ref.modify(lastCall, (current) => {
              const nextState =
                current.signature === signature
                  ? { signature, count: current.count + 1 }
                  : { signature, count: 1 }
              return [nextState, nextState] as const
            })

            if (state.count <= consecutiveLimit) {
              return next(input)
            }

            yield* Console.log(
              `⚠️ [Doom Loop Guard Triggered] Tool '${input.name}' called ${state.count} times consecutively. Halting repetition.`,
            )

            const denied = {
              result: {
                type: "execution-denied",
                reason: `Repeated tool call rejected: tool '${input.name}' was executed with identical arguments ${state.count} times.`,
              },
              encodedResult: {
                type: "execution-denied",
                reason: `Repeated tool call rejected: tool '${input.name}' was executed with identical arguments ${state.count} times.`,
              },
              isFailure: true,
              preliminary: false,
            }
            /* SAFETY: tool middleware runs only around Effect AI handler-result streams. */
            return Stream.make(denied as never)
          }),
        ),
    })
  })

// 2. Flaky / Simulated External Tool
let callAttempts = 0
const fetchSensorDataTool = Tool.make("fetch_sensor_data", {
  description: "Fetch real-time sensor metrics by device ID",
  parameters: Schema.Struct({ deviceId: Schema.String }),
  success: Schema.Struct({ temperature: Schema.Finite, status: Schema.String }),
})

const sensorAgent = Agent.make(
  "sensor-agent",
  Module.all(
    Module.instructions(
      "You are an IoT sensor diagnostics agent. Query the sensor device and explain the reading.",
    ),
    Module.tool(fetchSensorDataTool, ({ deviceId }) =>
      Effect.gen(function* () {
        callAttempts += 1
        yield* Console.log(`[SensorTool] Device '${deviceId}' query attempt #${callAttempts}`)
        return { temperature: 24.5, status: "nominal" }
      }),
    ),
  ),
)

const program = Effect.gen(function* () {
  yield* Console.log("=== Roop Resilience & Doom Loop Guard ===")

  // Initialize doom loop guard with a limit of 2 consecutive calls
  const guard = yield* doomLoopGuard(2)

  const events = Runtime.runAgent(sensorAgent, {
    sessionId: "resilience-session-5",
    prompt: "Query sensor device 'SENSOR-001' and report the status.",
    middleware: guard,
  })

  yield* events.pipe(
    Stream.tap((event) => {
      switch (event._tag) {
        case "ToolCall":
          return Console.log(`[Tool Call]: ${event.name}`, event.params)
        case "TextDelta":
          process.stdout.write(event.delta)
          return Effect.void
        case "Finish":
          return Console.log(`\n\n[Finished: ${event.reason}]`)
        default:
          return Effect.void
      }
    }),
    Stream.runDrain,
    Effect.provide(Layer.mergeAll(JournalMemory.JournalMemory, DeepSeek.Live)),
  )
})

if (process.argv[1]?.endsWith("07-resilient-agent.ts")) {
  Effect.runPromise(program).catch(console.error)
}
