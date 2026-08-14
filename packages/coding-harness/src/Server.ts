import { createServer } from "node:http"

import {
  NodeChildProcessSpawner,
  NodeFileSystem,
  NodeHttpServer,
  NodePath,
} from "@effect/platform-node"
import { DeepSeekLive } from "@roop/agent-node/DeepSeek.ts"
import { AgentRpcServerHttp } from "@roop/agent-rpc/AgentRpcHttp.ts"
import { AgentLiveToolkit } from "@roop/agent/Agent.ts"
import { SessionStoreMemory } from "@roop/agent/SessionStore.ts"
import { Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"

import { HarnessTools } from "./HarnessTools.ts"

export const server = (options: {
  readonly port: number
  readonly root: string
  readonly apiKey: string
}) => {
  const harness = HarnessTools(options.root)
  const agent = AgentLiveToolkit(harness.toolkit).pipe(
    Layer.provide(harness.live),
    Layer.provide(DeepSeekLive(options.apiKey)),
    Layer.provide(SessionStoreMemory),
    Layer.provide(NodeChildProcessSpawner.layer),
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(NodePath.layer),
  )

  return HttpRouter.serve(AgentRpcServerHttp("/rpc").pipe(Layer.provide(agent))).pipe(
    Layer.provide(NodeHttpServer.layer(() => createServer(), { port: options.port })),
  )
}
