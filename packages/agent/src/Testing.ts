import { Effect, Ref, Stream } from "effect"
import { LanguageModel, type Response } from "effect/unstable/ai"

/**
 * A fake `LanguageModel` that replays scripted turns: each `streamText` call
 * returns the next batch of encoded stream parts, then nothing once the script
 * runs out. Pass a `prompts` ref to record the prompt content of every
 * request (the model-facing view, after hook rewrites).
 */
export const scripted = Effect.fn("Testing.scripted")(function* (
  turns: ReadonlyArray<ReadonlyArray<Response.StreamPartEncoded>>,
  prompts?: Ref.Ref<Array<ReadonlyArray<unknown>>>,
) {
  const index = yield* Ref.make(0)
  return yield* LanguageModel.make({
    generateText: () => Effect.succeed([]),
    streamText: (options) =>
      Stream.unwrap(
        Effect.gen(function* () {
          if (prompts !== undefined) {
            yield* Ref.update(prompts, (seen) => [...seen, options.prompt.content])
          }
          const i = yield* Ref.getAndUpdate(index, (n) => n + 1)
          return Stream.fromIterable(turns[i] ?? [])
        }),
      ),
  })
})
