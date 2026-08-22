import { Middleware } from "@roop/agent"
import { Context, Effect, Stream } from "effect"

export interface ApprovalRequest {
  readonly sessionId: string
  readonly tool: string
  readonly params: unknown
}

export class ApprovalService extends Context.Service<
  ApprovalService,
  { readonly approve: (request: ApprovalRequest) => Effect.Effect<boolean> }
>()("example/ApprovalService") {}

/** Deny a tool as one model-visible failed result without running its handler. */
export const approval: Middleware.Middleware<ApprovalService> = Middleware.make({
  tool: (next) => (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const service = yield* ApprovalService
        if (
          yield* service.approve({
            sessionId: input.sessionId,
            tool: input.name,
            params: input.params,
          })
        ) {
          return next(input)
        }
        const denied = {
          result: { type: "execution-denied", reason: "approval denied" },
          encodedResult: { type: "execution-denied", reason: "approval denied" },
          isFailure: true,
          preliminary: false,
        }
        /* SAFETY: tool middleware runs only around Effect AI handler-result streams. */
        return Stream.make(denied as never)
      }),
    ),
})
