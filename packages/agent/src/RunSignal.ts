import { Deferred, Effect, Option, Queue } from "effect"

/** The control-plane outcome the run machinery reacts to. */
export type ControlSignal =
  | { readonly _tag: "Interrupted" }
  | { readonly _tag: "Steered"; readonly steerPrompt: string }

/**
 * Cooperative control surface of an active run. Produced by the RunRegistry
 * from its interrupt deferred and steer queue; consumed by the run executor.
 */
export interface InterruptSignal {
  readonly isInterrupted: Effect.Effect<boolean>
  readonly await: Effect.Effect<void>
  readonly pollSteer: Effect.Effect<Option.Option<string>>
  readonly awaitSteer: Effect.Effect<string>
  readonly awaitSignal: Effect.Effect<ControlSignal>
}

export const InterruptSignal = {
  make: (
    options: {
      readonly interruptDeferred?: Deferred.Deferred<void>
      readonly steerQueue?: Queue.Queue<string>
    } = {},
  ): InterruptSignal => {
    const interruptDeferred = options.interruptDeferred
    const steerQueue = options.steerQueue
    const isInterrupted =
      interruptDeferred !== undefined ? Deferred.isDone(interruptDeferred) : Effect.succeed(false)
    const awaitInterrupt =
      interruptDeferred !== undefined ? Deferred.await(interruptDeferred) : Effect.never
    const pollSteer =
      steerQueue !== undefined ? Queue.poll(steerQueue) : Effect.succeed(Option.none())
    const awaitSteer = steerQueue !== undefined ? Queue.take(steerQueue) : Effect.never
    return {
      isInterrupted,
      await: awaitInterrupt,
      pollSteer,
      awaitSteer,
      awaitSignal: Effect.raceFirst(
        awaitInterrupt.pipe(Effect.as({ _tag: "Interrupted" as const })),
        awaitSteer.pipe(Effect.map((steerPrompt) => ({ _tag: "Steered" as const, steerPrompt }))),
      ),
    }
  },
  noop: (): InterruptSignal => InterruptSignal.make(),
  interrupted: (): InterruptSignal => ({
    isInterrupted: Effect.succeed(true),
    await: Effect.void,
    pollSteer: Effect.succeed(Option.none()),
    awaitSteer: Effect.never,
    awaitSignal: Effect.succeed({ _tag: "Interrupted" as const }),
  }),
}
