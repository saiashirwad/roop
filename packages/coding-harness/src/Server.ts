import { createServer } from "node:http"

import {
  NodeChildProcessSpawner,
  NodeFileSystem,
  NodeHttpServer,
  NodePath,
} from "@effect/platform-node"
import { DeepSeek } from "@roop/agent-node/DeepSeek.ts"
import { AgentRpcServerHttp } from "@roop/agent-rpc/AgentRpcHttp.ts"
import { AgentPlugins } from "@roop/agent/Plugin.ts"
import { SessionStoreMemory } from "@roop/agent/SessionStore.ts"
import { subagent } from "@roop/agent/subagent.ts"
import { CodingTools } from "@roop/coding-tools/CodingTools.ts"
import { Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"

export const server = (options: {
  readonly port: number
  readonly root: string
  readonly apiKey: string
}) => {
  const agent = AgentPlugins([
    CodingTools(options.root),
    DeepSeek(options.apiKey),
    subagent({
      name: "task",
      description:
        "Delegate a self-contained coding task to a subagent with its own coding tools. Give it one complete task and receive a summary.",
      plugins: [CodingTools(options.root), DeepSeek(options.apiKey)],
      maxTurns: 25,
    }),
  ]).pipe(
    Layer.provide(SessionStoreMemory),
    Layer.provide(NodeChildProcessSpawner.layer),
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(NodePath.layer),
  )

  return HttpRouter.serve(AgentRpcServerHttp("/rpc").pipe(Layer.provide(agent))).pipe(
    Layer.provide(NodeHttpServer.layer(() => createServer(), { port: options.port })),
  )
}
