import {
  NodeChildProcessSpawner,
  NodeFileSystem,
  NodePath,
  NodeRuntime,
  NodeTerminal,
} from "@effect/platform-node"
import { makeAgentLive } from "@roop/core/Agent.ts"
import { AgentRunnerLive } from "@roop/core/AgentRunner.ts"
import { run } from "@roop/core/App.ts"
import { ModelCatalogLive } from "@roop/pack/model.ts"
import {
  packAgentMeta,
  PackAgentRegistryLive,
  PackToolkit,
  PackToolsLive,
} from "@roop/pack/pack.ts"
import { AgentClient } from "@roop/rpc/AgentClient.ts"
import { AgentRpc } from "@roop/rpc/AgentRpc.ts"
import { AgentServerLayer } from "@roop/rpc/AgentServer.ts"
import { Effect, Layer } from "effect"
import { RpcTest } from "effect/unstable/rpc"

import { makeJsonlSessionStack, makeSqliteSessionStack } from "./sessionStack.ts"
import { TerminalAppLive } from "./Terminal.ts"

/** ROOP_STORE selects the durability backend; the label flows into /caps unchanged. */
const storeKind = process.env.ROOP_STORE === "sqlite" ? ("sqlite" as const) : ("jsonl" as const)

const { log: LogLive, search: SearchLive } =
  storeKind === "sqlite"
    ? makeSqliteSessionStack(".roop/sessions.db")
    : makeJsonlSessionStack(".roop/sessions", NodeFileSystem.layer, NodePath.layer)

/** Sequential provide — mergeAll does not eliminate multiple platform R tags. */
const provideHost = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  layer.pipe(
    Layer.provide(NodeChildProcessSpawner.layer),
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(NodePath.layer),
  )

/** One shared runner for parent runs + spawnAgent (interrupt tree). */
const RunnerLive = AgentRunnerLive.pipe(
  Layer.provide(LogLive),
  Layer.provide(provideHost(PackAgentRegistryLive)),
)

const ToolsLive = provideHost(PackToolsLive)

const Agent = makeAgentLive(
  PackToolkit,
  packAgentMeta({ store: storeKind, hub: "in-process", search: "from-store" }),
).pipe(
  Layer.provide(ModelCatalogLive),
  Layer.provide(ToolsLive),
  Layer.provide(LogLive),
  Layer.provide(RunnerLive),
)

const AgentServer = AgentServerLayer.pipe(
  Layer.provide(Agent),
  Layer.provide(LogLive),
  Layer.provide(SearchLive),
)

const TerminalAgent = TerminalAppLive.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.effect(
        AgentClient,
        Effect.gen(function* () {
          return AgentClient.of(yield* RpcTest.makeClient(AgentRpc))
        }),
      ).pipe(Layer.provideMerge(AgentServer)),
      NodeTerminal.layer,
      NodeFileSystem.layer,
      NodePath.layer,
    ),
  ),
)

NodeRuntime.runMain(run.pipe(Effect.provide(TerminalAgent)))
