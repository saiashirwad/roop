import { createServer } from "node:http"
import { homedir } from "node:os"
import { join } from "node:path"

import {
  NodeChildProcessSpawner,
  NodeFileSystem,
  NodeHttpClient,
  NodeHttpServer,
  NodePath,
} from "@effect/platform-node"
import { AgentRpcServerHttp } from "@roop/agent-rpc/AgentRpcHttp.ts"
import { AgentPlugins } from "@roop/agent/Plugin.ts"
import { SessionStoreMemory } from "@roop/agent/SessionStore.ts"
import { subagent } from "@roop/agent/subagent.ts"
import { CodingTools } from "@roop/coding-tools/CodingTools.ts"
import { OpenAiCompatible } from "@roop/plugin-openai/OpenAiCompatible.ts"
import { SkillsDir } from "@roop/plugin-skills/SkillsDir.ts"
import { Todos } from "@roop/plugin-todo/Todos.ts"
import { WebTools } from "@roop/plugin-web/WebTools.ts"
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"

export const server = (options: {
  readonly port: number
  readonly root: string
  readonly apiKey: string
}) => {
  const deepseek = OpenAiCompatible({
    name: "deepseek",
    apiUrl: "https://api.deepseek.com",
    apiKey: options.apiKey,
    models: [{ id: "deepseek-chat", description: "DeepSeek V3 via the OpenAI-compatible API" }],
  })

  const agent = Layer.unwrap(
    Effect.gen(function* () {
      const skills = yield* SkillsDir(join(homedir(), ".agents", "skills"))
      return AgentPlugins([
        CodingTools(options.root),
        WebTools(),
        Todos(),
        skills,
        deepseek,
        subagent({
          name: "task",
          description:
            "Delegate a self-contained coding task to a subagent with its own coding tools. Give it one complete task and receive a summary.",
          plugins: [CodingTools(options.root), WebTools(), deepseek],
          maxTurns: 25,
        }),
      ])
    }),
  ).pipe(
    Layer.provide(SessionStoreMemory),
    Layer.provide(NodeChildProcessSpawner.layer),
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(NodeHttpClient.layerUndici),
    Layer.provide(NodePath.layer),
  )

  return HttpRouter.serve(AgentRpcServerHttp("/rpc").pipe(Layer.provide(agent))).pipe(
    Layer.provide(NodeHttpServer.layer(() => createServer(), { port: options.port })),
  )
}
