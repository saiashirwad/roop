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
        const isApproved = yield* service.approve({
          sessionId: input.sessionId,
          tool: input.name,
          params: input.params,
        })
        if (isApproved) {
          return next(input)
        }
        return Middleware.denyTool("approval denied")
      }),
    ),
})
