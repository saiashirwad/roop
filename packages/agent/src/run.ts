import { Schema, Stream } from "effect"

import type { AgentEvent } from "./AgentEvents.ts"
import { run as internalRun, type RunOptions } from "./internal/run.ts"
import { runError, RunError } from "./RunError.ts"

export type { RunOptions }

/** Temporary compatibility export for the old Plugin-based host. */
export const run = (options: RunOptions): Stream.Stream<AgentEvent, RunError> =>
  internalRun(options).pipe(
    Stream.mapError((error) =>
      Schema.is(RunError)(error)
        ? error
        : runError(error, { sessionId: String(options.sessionId) }, "interpreter"),
    ),
  )
