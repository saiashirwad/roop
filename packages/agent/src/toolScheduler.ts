import { Effect, Semaphore, Stream } from "effect"

export interface ToolScheduler {
  /** Limit an already-created result stream for its complete consumption lifetime. */
  readonly schedule: <A, E, R>(stream: Stream.Stream<A, E, R>) => Stream.Stream<A, E, R>
  /**
   * Acquire a permit before evaluating the effect that starts a tool handler,
   * then retain it until the handler's result stream closes.
   */
  readonly scheduleEffect: <A, E, R, E2, R2>(
    effect: Effect.Effect<Stream.Stream<A, E, R>, E2, R2>,
  ) => Stream.Stream<A, E | E2, R | R2>
}

/**
 * Creates a run-scoped tool execution scheduler.
 * When bounded, holding permits across the entire result stream ensures
 * streaming tool handlers strictly adhere to `RunPolicy.toolConcurrency`.
 */
export const makeToolScheduler = (
  concurrency: number | "unbounded",
): Effect.Effect<ToolScheduler> => {
  if (concurrency === "unbounded") {
    return Effect.succeed({
      schedule: (stream) => stream,
      scheduleEffect: (effect) => Stream.unwrap(effect),
    })
  }

  const permits = Math.max(1, Math.floor(concurrency))
  return Effect.map(Semaphore.make(permits), (semaphore) => {
    const withPermit = <A, E, R, E2, R2>(
      effect: Effect.Effect<Stream.Stream<A, E, R>, E2, R2>,
    ): Stream.Stream<A, E | E2, R | R2> =>
      Stream.scoped(
        Stream.unwrap(
          Effect.acquireRelease(semaphore.take(1), () => semaphore.release(1)).pipe(
            Effect.andThen(effect),
          ),
        ),
      )

    return {
      schedule: <A, E, R>(stream: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> =>
        withPermit(Effect.succeed(stream)),
      scheduleEffect: withPermit,
    }
  })
}
