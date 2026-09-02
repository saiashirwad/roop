import { Agent, Journal, Middleware, Roop } from "@roop/agent"
import { Console, Context, Effect, Layer, Schema, Stream } from "effect"
import { Tool } from "effect/unstable/ai"

import { DeepSeek } from "./deepseek.ts"

export interface ApprovalRequest {
  readonly sessionId: string
  readonly tool: string
  readonly params: unknown
}

export class ApprovalService extends Context.Service<
  ApprovalService,
  {
    readonly approve: (request: ApprovalRequest) => Effect.Effect<boolean>
  }
>()("example/ApprovalService") {}

export const approvalMiddleware: Middleware.Middleware<ApprovalService> = Middleware.make({
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

        return Middleware.denyTool("Action requires manager approval which was denied.")
      }),
    ),
})

const checkBalanceDefinition = Tool.make("check_balance", {
  description: "Check user bank account balance",
  parameters: Schema.Struct({ accountId: Schema.String }),
  success: Schema.Struct({ balance: Schema.Finite, currency: Schema.String }),
})

const transferFundsDefinition = Tool.make("transfer_funds", {
  description: "Transfer money from source account to destination account",
  parameters: Schema.Struct({
    sourceAccount: Schema.String,
    destinationAccount: Schema.String,
    amount: Schema.Finite,
  }),
  success: Schema.Struct({ transactionId: Schema.String, status: Schema.String }),
})

const checkBalance = Agent.tool(checkBalanceDefinition, ({ accountId: _accountId }) =>
  Effect.succeed({ balance: 5400.5, currency: "USD" }),
)

const transferFunds = Agent.tool(
  transferFundsDefinition,
  ({ amount: _amount, destinationAccount: _destinationAccount, sourceAccount: _sourceAccount }) =>
    Effect.succeed({ transactionId: "TXN-88219", status: "completed" }),
)

const bankingAgent = Agent.make({
  name: "banking-agent",
  instructions:
    "You are an automated banking assistant. Help users with account balances and fund transfers.",
  tools: [checkBalance, transferFunds],
  middleware: approvalMiddleware,
})

const TransferParamsSchema = Schema.Struct({
  amount: Schema.optionalKey(Schema.Finite),
})

const ApprovalLive = Layer.succeed(ApprovalService, {
  approve: (req) =>
    Effect.sync(() => {
      if (req.tool === "check_balance") return true
      if (req.tool === "transfer_funds") {
        const decoded = Schema.decodeUnknownOption(TransferParamsSchema)(req.params)
        const amount = decoded._tag === "Some" ? (decoded.value.amount ?? 0) : 0
        return amount <= 1000
      }
      return false
    }),
})

const AppLive = Layer.mergeAll(
  Roop.layer({
    model: DeepSeek.Live,
    journal: Journal.memory,
  }),
  ApprovalLive,
)

const program = Effect.gen(function* () {
  const reply = yield* Agent.run(bankingAgent, {
    sessionId: "banking-session-9",
    prompt: "Please transfer $2,500 from account ACC-101 to account ACC-999.",
  })

  yield* Console.log(reply.text)
}).pipe(Effect.provide(AppLive))

if (process.argv[1]?.endsWith("human-in-the-loop.ts")) {
  Effect.runPromise(program).catch(console.error)
}
