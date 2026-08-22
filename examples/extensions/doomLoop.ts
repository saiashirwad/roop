import { Middleware } from "@roop/agent"
import { Effect, Ref, Stream } from "effect"

/** Reject a repeated tool call after the configured consecutive limit. */
export const doomLoop = (limit: number): Effect.Effect<Middleware.Middleware> =>
  Effect.gen(function* () {
    const previous = yield* Ref.make({ signature: "", count: 0 })
    return Middleware.make({
      tool: (next) => (input) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const signature = JSON.stringify([input.name, input.params])
            const state = yield* Ref.modify(previous, (current) => {
              const nextState =
                current.signature === signature
                  ? { signature, count: current.count + 1 }
                  : { signature, count: 1 }
              return [nextState, nextState] as const
            })
            if (state.count <= limit) return next(input)
            const denied = {
              result: { type: "execution-denied", reason: "repeating tool call" },
              encodedResult: { type: "execution-denied", reason: "repeating tool call" },
              isFailure: true,
              preliminary: false,
            }
            /* SAFETY: tool middleware runs only around Effect AI handler-result streams. */
            return Stream.make(denied as never)
          }),
        ),
    })
  })
