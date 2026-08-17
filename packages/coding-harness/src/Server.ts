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
import { SessionJournalFs } from "@roop/agent/SessionJournal.ts"
import { subagent } from "@roop/agent/Subagent.ts"
import { CodingTools } from "@roop/coding-tools/CodingTools.ts"
import { ExecutionWorld } from "@roop/coding-tools/ExecutionWorld.ts"
import { Claude, Codex, OpenAiCompatible, SkillsDir, Todos, WebTools } from "@roop/plugins"
import { Effect, Layer, Path } from "effect"
import { HttpRouter } from "effect/unstable/http"

/**
 * Model plugins gated on what the environment provides: DeepSeek needs a
 * non-empty API key (an empty one is treated as absent so the server boots
 * local-only instead of 401-ing at request time), while Claude and Codex are
 * local CLIs and always register. The `delegation` list omits Claude, matching
 * the models subagents may use.
 */
export const modelPlugins = (deepseekApiKey: string | undefined) => {
  const apiKey = deepseekApiKey?.trim()
  const deepseek =
    apiKey === undefined || apiKey === ""
      ? undefined
      : OpenAiCompatible({
          name: "deepseek",
          apiUrl: "https://api.deepseek.com",
          apiKey,
          models: [
            { id: "deepseek-chat", description: "DeepSeek V3 via the OpenAI-compatible API" },
          ],
        })
  const codex = Codex()
  return {
    /** Registered in the harness agent. */
    agent: deepseek === undefined ? [Claude(), codex] : [deepseek, Claude(), codex],
    /** Model plugins also handed to delegated subagents. */
    delegation: deepseek === undefined ? [codex] : [codex, deepseek],
  }
}

export const server = (options: {
  readonly port: number
  readonly root: string
  /** Omit to run without DeepSeek; only the local CLI models register. */
  readonly deepseekApiKey?: string | undefined
  /** Keep the unauthenticated development server private by default. */
  readonly host?: string | undefined
}) => {
  const models = modelPlugins(options.deepseekApiKey)
  const codingTools = CodingTools()
  const webTools = WebTools()

  const agent = Layer.unwrap(
    Effect.gen(function* () {
      const path = yield* Path.Path
      const skills = yield* SkillsDir(path.join(homedir(), ".agents", "skills"))
      return AgentPlugins([
        codingTools,
        webTools,
        Todos(),
        skills,
        ...models.agent,
        subagent({
          name: delegationToolName,
          description:
            "Delegate a self-contained coding task to a subagent in an isolated Git worktree. Give it one complete task and receive a summary.",
          plugins: [codingTools, webTools, ...models.delegation],
          layer: ExecutionWorld.worktreeFromParent(),
          policy: { maxTotalSteps: 25 },
        }),
      ]).pipe(Layer.provide(SessionJournalFs(path.join(options.root, ".roop", "sessions"))))
    }),
  ).pipe(
    Layer.provide(ExecutionWorld.local(options.root)),
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
        host: options.host ?? "127.0.0.1",
      }),
    ),
  )
}
