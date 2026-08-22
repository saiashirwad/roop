import { Agent, JournalMemory, Module, Runtime } from "@roop/agent"
import { Console, Context, DateTime, Effect, Layer, Schema, Stream } from "effect"
import { Tool } from "effect/unstable/ai"

import { DeepSeek } from "./deepseek.ts"

/**
 * 08 - Dynamic Modules & Contextual Capabilities
 *
 * Demonstrates how Roop constructs dynamic agents where tools and instructions
 * are conditionally attached at runtime using `Module.when` and `Module.provide`.
 */

// 1. User Context Service (e.g. Authenticated User Role)
export interface UserRole {
  readonly isAdmin: boolean
  readonly tier: "standard" | "vip"
}

export class CurrentUser extends Context.Service<CurrentUser, UserRole>()("example/CurrentUser") {}

// 2. Standard Tools vs Admin Tools
const searchFaqTool = Tool.make("search_faq", {
  description: "Search public FAQ articles",
  parameters: Schema.Struct({ query: Schema.String }),
  success: Schema.Struct({ answer: Schema.String }),
})

const restartServerTool = Tool.make("restart_server", {
  description: "Administrative tool to restart production server instances",
  parameters: Schema.Struct({ serverId: Schema.String }),
  success: Schema.Struct({ status: Schema.String, restartedAt: Schema.String }),
})

// 3. Define Standard and Admin Modules
const standardModule = Module.all(
  Module.instructions("You are a helpful customer portal assistant."),
  Module.tool(searchFaqTool, ({ query }) =>
    Effect.succeed({ answer: `FAQ results for '${query}': Standard operations are 24/7.` }),
  ),
)

const adminModule = Module.all(
  Module.instructions(
    "ADMIN PRIVILEGES ACTIVE: You may inspect and restart backend server instances.",
  ),
  Module.tool(restartServerTool, ({ serverId: _serverId }) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now
      return { status: "restarted", restartedAt: DateTime.formatIso(now) }
    }),
  ),
)

// 4. Compose Dynamically with `Module.when`
const makeDynamicAgent = (user: UserRole) =>
  Agent.make(
    "dynamic-assistant",
    Module.all(
      standardModule,
      // Admin tools & instructions are only rendered when the user has admin role
      Module.when(user.isAdmin, adminModule),
    ),
  )

const program = Effect.gen(function* () {
  yield* Console.log("=== Roop Dynamic Modules Agent ===")

  // Scenario A: Standard User (admin tools are excluded from the model prompt completely)
  yield* Console.log("\n--- Running with Standard User ---")
  const standardUser: UserRole = { isAdmin: false, tier: "standard" }
  const standardAgent = makeDynamicAgent(standardUser)

  yield* Runtime.runAgent(standardAgent, {
    sessionId: "user-session-std",
    prompt: "Can you restart server 'SRV-01'?",
  }).pipe(
    Stream.tap((event) => {
      if (event._tag === "TextDelta") process.stdout.write(event.delta)
      return Effect.void
    }),
    Stream.runDrain,
  )

  // Scenario B: Admin User (admin tools & instructions are rendered into the plan)
  yield* Console.log("\n\n--- Running with Admin User ---")
  const adminUser: UserRole = { isAdmin: true, tier: "vip" }
  const adminAgent = makeDynamicAgent(adminUser)

  yield* Runtime.runAgent(adminAgent, {
    sessionId: "user-session-admin",
    prompt: "Can you restart server 'SRV-01'?",
  }).pipe(
    Stream.tap((event) => {
      switch (event._tag) {
        case "ToolCall":
          return Console.log(`\n[Admin Tool Executed]: ${event.name}`, event.params)
        case "TextDelta":
          process.stdout.write(event.delta)
          return Effect.void
        default:
          return Effect.void
      }
    }),
    Stream.runDrain,
  )
  yield* Console.log("")
}).pipe(Effect.provide(Layer.mergeAll(JournalMemory.JournalMemory, DeepSeek.Live)))

if (process.argv[1]?.endsWith("08-dynamic-modules.ts")) {
  Effect.runPromise(program).catch(console.error)
}
