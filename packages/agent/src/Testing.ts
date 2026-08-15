import { Effect, Layer, Ref, Stream } from "effect"
import { LanguageModel, type Response } from "effect/unstable/ai"

import { Plugin } from "./Plugin.ts"

/**
 * A fake `LanguageModel` that replays scripted turns: each `streamText` call
 * returns the next batch of encoded stream parts, then nothing once the script
 * runs out. Pass a `prompts` ref to record the prompt content of every
 * request (the model-facing view, after hook rewrites).
 */
export const scripted = (
  turns: ReadonlyArray<ReadonlyArray<Response.StreamPartEncoded>>,
  prompts?: Ref.Ref<Array<ReadonlyArray<unknown>>>,
): Effect.Effect<LanguageModel.Service> =>
  Effect.gen(function* () {
    const index = yield* Ref.make(0)
    return yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: (options: {
        readonly prompt: { readonly content: ReadonlyArray<{ role: string; content: unknown }> }
      }) =>
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

/** A plugin contributing one scripted model, for composing test agents. */
export const scriptedPlugin = (
  id: string,
  turns: ReadonlyArray<ReadonlyArray<Response.StreamPartEncoded>>,
  options?: {
    readonly provider?: string | undefined
    readonly description?: string | undefined
    readonly prompts?: Ref.Ref<Array<ReadonlyArray<unknown>>> | undefined
  },
): Plugin =>
  Plugin({
    name: `model-${id}`,
    models: [
      {
        id,
        provider: options?.provider ?? "test",
        ...(options?.description === undefined ? undefined : { description: options.description }),
        layer: Layer.effect(LanguageModel.LanguageModel, scripted(turns, options?.prompts)),
      },
    ],
  })
