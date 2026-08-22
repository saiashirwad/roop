import { Context, Effect, Schema, type Stream } from "effect"
import { LanguageModel, Tool, type AiError } from "effect/unstable/ai"

import { Agent } from "../src/Agent.ts"
import { Module } from "../src/Module.ts"
import { runAgent } from "../src/Runtime.ts"

class Account extends Context.Service<Account, { readonly id: string }>()("test/Account") {}

const Lookup = Tool.make("lookup", {
  parameters: Schema.Struct({}),
  success: Schema.String,
  dependencies: [Account],
})

const agent = Agent.make(
  "typed",
  Module.tool(Lookup, () =>
    Effect.gen(function* () {
      return (yield* Account).id
    }),
  ),
)

const stream = runAgent(agent, { sessionId: "types", prompt: "lookup" })
type Requirements = typeof stream extends Stream.Stream<unknown, unknown, infer R> ? R : never
type Errors = typeof stream extends Stream.Stream<unknown, infer E, unknown> ? E : never

const accountRequirement: Extract<Requirements, Account> = Account
const modelRequirement: Extract<Requirements, LanguageModel.LanguageModel> =
  LanguageModel.LanguageModel
// SAFETY: this compile-only sentinel checks that the public error union
// contains Effect AI failures; `never` is never executed.
const aiError: Extract<Errors, AiError.AiError> = undefined as never
// SAFETY: this compile-only sentinel is never executed; `never` is assignable
// to every inferred error union without widening the public declaration.
const _errors: Errors = undefined as never
void accountRequirement
void modelRequirement
void aiError
void _errors
