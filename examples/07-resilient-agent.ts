import { Agent, Journal, Middleware, Roop } from "@roop/agent"
import { Console, Effect, Ref, Schema, Stream } from "effect"
import { Tool } from "effect/unstable/ai"

import { DeepSeek } from "./deepseek.ts"

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

            return Middleware.denyTool(
              `Repeated tool call rejected: tool '${input.name}' was executed with identical arguments ${state.count} times.`,
            )
          }),
        ),
    })
  })

const fetchSensorDataDefinition = Tool.make("fetch_sensor_data", {
  description: "Fetch real-time sensor metrics by device ID",
  parameters: Schema.Struct({ deviceId: Schema.String }),
  success: Schema.Struct({ temperature: Schema.Finite, status: Schema.String }),
})

const fetchSensorData = Agent.tool(fetchSensorDataDefinition, ({ deviceId: _deviceId }) =>
  Effect.succeed({ temperature: 24.5, status: "nominal" }),
)

const sensorAgent = Agent.make({
  name: "sensor-agent",
  instructions:
    "You are an IoT sensor diagnostics agent. Query the sensor device and explain the reading.",
  tools: [fetchSensorData],
})

const Live = Roop.layer({
  model: DeepSeek.Live,
  journal: Journal.memory,
})

const program = Effect.gen(function* () {
  const guard = yield* doomLoopGuard(2)
  const resilientAgent = sensorAgent.pipe(Agent.withMiddleware(guard))

  const reply = yield* Agent.run(resilientAgent, {
    sessionId: "resilience-session-5",
    prompt: "Query sensor device 'SENSOR-001' and report the status.",
  })

  yield* Console.log(reply.text)
}).pipe(Effect.provide(Live))

if (process.argv[1]?.endsWith("07-resilient-agent.ts")) {
  Effect.runPromise(program).catch(console.error)
}
