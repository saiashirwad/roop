import { Effect, PlatformError, Schema } from "effect"

export const ToolFailure = Schema.Struct({
  message: Schema.String,
  reason: Schema.String,
})

export type ToolFailure = typeof ToolFailure.Type

export const toToolFailure = (error: PlatformError.PlatformError) =>
  Effect.fail({
    message: error.message,
    reason: error.reason._tag,
  } satisfies ToolFailure)
