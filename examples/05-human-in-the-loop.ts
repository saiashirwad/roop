import { Agent, JournalMemory, Middleware, Module, Runtime } from "@roop/agent"
import { Console, Context, Effect, Layer, Schema, Stream } from "effect"
import { Tool } from "effect/unstable/ai"

import { DeepSeek } from "./deepseek.ts"

/**
 * 05 - Human-in-the-Loop & Tool Execution Approval
 *
 * Demonstrates how Roop intercepts sensitive tool calls using composable Middleware.
 * Safe tools execute freely; destructive tools (e.g. money transfer) require
 * explicit authorization via `ApprovalService`.
 */

export interface ApprovalRequest {
  readonly sessionId: string
  readonly tool: string
  readonly params: unknown
}

// 1. Approval Service Tag
export class ApprovalService extends Context.Service<
  ApprovalService,
  {
    readonly approve: (request: ApprovalRequest) => Effect.Effect<boolean>
  }
>()("example/ApprovalService") {}

// 2. Approval Middleware: intercepts tool execution before the handler runs
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
          yield* Console.log(`✅ [Approval Granted] Tool '${input.name}' approved for execution.`)
          return next(input)
        }

        yield* Console.log(`🚫 [Approval Denied] Tool '${input.name}' execution blocked by policy.`)
        const denied = {
          result: {
            type: "execution-denied",
            reason: "Action requires manager approval which was denied.",
          },
          encodedResult: {
            type: "execution-denied",
            reason: "Action requires manager approval which was denied.",
          },
          isFailure: true,
          preliminary: false,
        }
        /* SAFETY: tool middleware runs only around Effect AI handler-result streams. */
        return Stream.make(denied as never)
      }),
    ),
})

// 3. Domain Tools
const checkBalanceTool = Tool.make("check_balance", {
  description: "Check user bank account balance",
  parameters: Schema.Struct({ accountId: Schema.String }),
  success: Schema.Struct({ balance: Schema.Finite, currency: Schema.String }),
})

const transferFundsTool = Tool.make("transfer_funds", {
  description: "Transfer money from source account to destination account",
  parameters: Schema.Struct({
    sourceAccount: Schema.String,
    destinationAccount: Schema.String,
    amount: Schema.Finite,
  }),
  success: Schema.Struct({ transactionId: Schema.String, status: Schema.String }),
})

// 4. Compose Banking Agent
const bankingAgent = Agent.make(
  "banking-agent",
  Module.all(
    Module.instructions(
      "You are an automated banking assistant. Help users with account balances and fund transfers.",
    ),
    Module.tool(checkBalanceTool, ({ accountId: _accountId }) =>
      Effect.succeed({ balance: 5400.5, currency: "USD" }),
    ),
    Module.tool(
      transferFundsTool,
      ({
        amount: _amount,
        destinationAccount: _destinationAccount,
        sourceAccount: _sourceAccount,
      }) => Effect.succeed({ transactionId: "TXN-88219", status: "completed" }),
    ),
  ),
)

// 5. Example Approval Provider: auto-approve reads, deny transfers over $1000
const TransferParamsSchema = Schema.Struct({
  amount: Schema.optionalKey(Schema.Finite),
})

const ApprovalLive = Layer.succeed(ApprovalService, {
  approve: (req) =>
    Effect.gen(function* () {
      yield* Console.log(`[Approval Gate] Evaluating policy for '${req.tool}'...`)
      if (req.tool === "check_balance") return true
      if (req.tool === "transfer_funds") {
        const decoded = Schema.decodeUnknownOption(TransferParamsSchema)(req.params)
        const amount = decoded._tag === "Some" ? (decoded.value.amount ?? 0) : 0
        // Deny transfers over $1,000 without manual 2FA/manager confirmation
        return amount <= 1000
      }
      return false
    }),
})

const program = Effect.gen(function* () {
  yield* Console.log("=== Roop Human-in-the-Loop & Approvals ===")

  const events = Runtime.runAgent(bankingAgent, {
    sessionId: "banking-session-9",
    prompt: "Please transfer $2,500 from account ACC-101 to account ACC-999.",
    middleware: approvalMiddleware,
  })

  yield* events.pipe(
    Stream.tap((event) => {
      switch (event._tag) {
        case "ToolCall":
          return Console.log(`\n[Agent proposed tool]: ${event.name}`, event.params)
        case "ToolResult":
          return Console.log(`[Tool outcome]:`, event.result)
        case "TextDelta":
          process.stdout.write(event.delta)
          return Effect.void
        case "Finish":
          return Console.log(`\n\n[Run finished: ${event.reason}]`)
        default:
          return Effect.void
      }
    }),
    Stream.runDrain,
    Effect.provide(Layer.mergeAll(JournalMemory.JournalMemory, ApprovalLive, DeepSeek.Live)),
  )
})

if (process.argv[1]?.endsWith("05-human-in-the-loop.ts")) {
  Effect.runPromise(program).catch(console.error)
}
