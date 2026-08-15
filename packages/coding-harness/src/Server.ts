import { homedir } from "node:os"

import {
  NodeChildProcessSpawner,
  NodeCrypto,
  NodeFileSystem,
  NodeHttpClient,
  NodeHttpServer,
  NodePath,
} from "@effect/platform-node"
import { AgentRpcServerHttp } from "@roop/agent-rpc/AgentRpcHttp.ts"
import { delegationToolName } from "@roop/agent-rpc/Transcript.ts"
import { AgentPlugins } from "@roop/agent/Plugin.ts"
import { SessionStoreFs } from "@roop/agent/SessionStore.ts"
import { subagent } from "@roop/agent/subagent.ts"
import { CodingTools } from "@roop/coding-tools/CodingTools.ts"
import { Claude } from "@roop/plugin-claude/Claude.ts"
import { Codex } from "@roop/plugin-codex/Codex.ts"
import { OpenAiCompatible } from "@roop/plugin-openai/OpenAiCompatible.ts"
import { SkillsDir } from "@roop/plugin-skills/SkillsDir.ts"
import { Todos } from "@roop/plugin-todo/Todos.ts"
import { WebTools } from "@roop/plugin-web/WebTools.ts"
import { Effect, Layer, Path } from "effect"
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
  const codingTools = CodingTools(options.root)
  const webTools = WebTools()
  const codex = Codex()

  const agent = Layer.unwrap(
    Effect.gen(function* () {
      const path = yield* Path.Path
      const skills = yield* SkillsDir(path.join(homedir(), ".agents", "skills"))
      return AgentPlugins([
        codingTools,
        webTools,
        Todos(),
        skills,
        deepseek,
        Claude(),
        codex,
        subagent({
          name: delegationToolName,
          description:
            "Delegate a self-contained coding task to a subagent with its own coding tools. Give it one complete task and receive a summary.",
          plugins: [codingTools, webTools, codex, deepseek],
          maxTurns: 25,
        }),
      ]).pipe(Layer.provide(SessionStoreFs(path.join(options.root, ".roop", "sessions"))))
    }),
  ).pipe(
    Layer.provide(NodeChildProcessSpawner.layer),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(NodeFileSystem.layer),
    Layer.provide(NodeHttpClient.layerUndici),
    Layer.provide(NodePath.layer),
  )

  return HttpRouter.serve(AgentRpcServerHttp("/rpc").pipe(Layer.provide(agent))).pipe(
    Layer.provide(
      NodeHttpServer.layer(process.getBuiltinModule("node:http").createServer, {
        port: options.port,
      }),
    ),
  )
}
