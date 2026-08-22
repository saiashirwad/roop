import { Middleware } from "@roop/agent"
import { type Cause, Effect, Stream } from "effect"
import type { LanguageModel } from "effect/unstable/ai"

/** Try one replacement model only when the primary fails before visible output. */
export const modelFallback = (
  fallback: LanguageModel.Service,
  shouldFallback: (cause: Cause.Cause<unknown>) => boolean = () => true,
): Middleware.Middleware =>
  Middleware.make({
    model: (next) => (input) =>
      Stream.unwrap(
        Effect.sync(() => {
          let emitted = false
          return next(input).pipe(
            Stream.tap(() => Effect.sync(() => (emitted = true))),
            Stream.catchCause((cause) =>
              emitted || !shouldFallback(cause)
                ? Stream.failCause(cause)
                : next({ ...input, attempt: input.attempt + 1, model: fallback }),
            ),
          )
        }),
      ),
  })
