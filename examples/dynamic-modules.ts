import { Agent, Journal, Roop } from "@roop/agent"
import { Console, Context, DateTime, Effect, Layer, Schema } from "effect"
import { Tool } from "effect/unstable/ai"

import { DeepSeek } from "./deepseek.ts"

export interface UserRole {
  readonly isAdmin: boolean
  readonly tier: "standard" | "vip"
}

export class CurrentUser extends Context.Service<CurrentUser, UserRole>()("example/CurrentUser") {}

const searchFaqDefinition = Tool.make("search_faq", {
  description: "Search public FAQ articles",
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.Struct({ answer: Schema.String }),
})

const restartServerDefinition = Tool.make("restart_server", {
  description: "Administrative tool to restart production server instances",
  parameters: Schema.Struct({ serverId: Schema.String }),
  success: Schema.Struct({ status: Schema.String, restartedAt: Schema.String }),
})

const searchFaq = Agent.tool(searchFaqDefinition, ({ query }) =>
  Effect.succeed({ answer: `FAQ results for '${query}': Standard operations are 24/7.` }),
)

const restartServer = Agent.tool(restartServerDefinition, ({ serverId: _serverId }) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now
    return { status: "restarted", restartedAt: DateTime.formatIso(now) }
  }),
)

const standardCapability = Agent.capability({
  name: "standard-support",
  instructions: "You are a helpful customer portal assistant.",
  tools: [searchFaq],
})

const adminCapability = Agent.capability({
  name: "admin-operations",
  instructions: "ADMIN PRIVILEGES ACTIVE: You may inspect and restart backend server instances.",
  tools: [restartServer],
})

const assistant = Agent.make({
  name: "dynamic-assistant",
  capabilities: [
    standardCapability,
    Agent.when(CurrentUser.pipe(Effect.map((user) => user.isAdmin)), adminCapability),
  ],
})

const program = Effect.gen(function* () {
  const standardLayer = Layer.mergeAll(
    Roop.layer({
      model: DeepSeek.Live,
      journal: Journal.memory,
    }),
    Layer.succeed(CurrentUser, { isAdmin: false, tier: "standard" }),
  )

  const stdReply = yield* Agent.run(assistant, {
    sessionId: "user-session-std",
    prompt: "Can you restart server 'SRV-01'?",
  }).pipe(Effect.provide(standardLayer))

  yield* Console.log(stdReply.text)

  const adminLayer = Layer.mergeAll(
    Roop.layer({
      model: DeepSeek.Live,
      journal: Journal.memory,
    }),
    Layer.succeed(CurrentUser, { isAdmin: true, tier: "vip" }),
  )

  const adminReply = yield* Agent.run(assistant, {
    sessionId: "user-session-admin",
    prompt: "Can you restart server 'SRV-01'?",
  }).pipe(Effect.provide(adminLayer))

  yield* Console.log(adminReply.text)
})

if (process.argv[1]?.endsWith("dynamic-modules.ts")) {
  Effect.runPromise(program).catch(console.error)
}
