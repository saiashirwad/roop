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
import { layerDoomLoopGuard, type DoomLoopPolicy } from "@roop/agent/DoomLoopGuard.ts"
import { AgentPlugins, Plugin } from "@roop/agent/Plugin.ts"
import { SessionJournalFs } from "@roop/agent/SessionJournal.ts"
import { subagent } from "@roop/agent/Subagent.ts"
import { layerToolPruning, type PrunePolicy } from "@roop/agent/ToolPruning.ts"
import { CodingTools } from "@roop/coding-tools/CodingTools.ts"
import { ExecutionWorld } from "@roop/coding-tools/ExecutionWorld.ts"
import { Snapshot, SnapshotHooks, type SnapshotHookOptions } from "@roop/coding-tools/Snapshot.ts"
import { Truncate } from "@roop/coding-tools/Truncate.ts"
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

/** The supplied safety preset remains configurable and entirely optional. */
export interface OperationalSafetyOptions {
  readonly doomLoop?: DoomLoopPolicy | undefined
  readonly toolPruning?: PrunePolicy | undefined
  readonly snapshots?: SnapshotHookOptions | undefined
}

/**
 * A composable hook plugin: callers may omit it, use this preset, or replace
 * it with their own `Plugin({ hooks })` implementation.
 */
export const operationalSafety = (options?: OperationalSafetyOptions) =>
  Plugin({
    name: "operational-safety",
    hooks: layerDoomLoopGuard(options?.doomLoop).pipe(
      Layer.provide(
        SnapshotHooks(options?.snapshots).pipe(
          Layer.provide(layerToolPruning(options?.toolPruning)),
        ),
      ),
    ),
  })

export const server = (options: {
  readonly port: number
  readonly root: string
  /** Omit to run without DeepSeek; only the local CLI models register. */
  readonly deepseekApiKey?: string | undefined
  /** Keep the unauthenticated development server private by default. */
  readonly host?: string | undefined
  /** The default safety plugin, or `false` to compose a fully custom policy. */
  readonly safety?: OperationalSafetyOptions | false | undefined
}) => {
  const models = modelPlugins(options.deepseekApiKey)
  const codingTools = CodingTools()
  const webTools = WebTools()
  const safety = options.safety === false ? undefined : operationalSafety(options.safety)

  const platformLayers = Layer.mergeAll(
    NodeFileSystem.layer,
    NodeChildProcessSpawner.layer.pipe(
      Layer.provide(NodeFileSystem.layer),
      Layer.provide(NodePath.layer),
    ),
    NodeCrypto.layer,
    NodeHttpClient.layerUndici,
    NodePath.layer,
  )

  const executionLayer = ExecutionWorld.local(options.root).pipe(Layer.provide(platformLayers))

  const toolLayers = Layer.mergeAll(Truncate.layer(), Snapshot.layer()).pipe(
    Layer.provide(executionLayer),
    Layer.provide(platformLayers),
  )

  // Each delegated agent gets fresh capabilities bound to its worktree.
  // Reusing the parent Truncate/Snapshot services here would capture the
  // parent's ExecutionWorld and spill files or snapshots into the wrong tree.
  const subagentRuntime = () =>
    Layer.mergeAll(Truncate.layer(), Snapshot.layer()).pipe(
      Layer.provideMerge(ExecutionWorld.worktreeFromParent()),
    )

  const agent = Layer.unwrap(
    Effect.gen(function* () {
      const path = yield* Path.Path
      const skills = yield* SkillsDir(path.join(homedir(), ".agents", "skills"))
      return AgentPlugins([
        codingTools,
        ...(safety === undefined ? [] : [safety]),
        webTools,
        Todos(),
        skills,
        ...models.agent,
        subagent({
          name: delegationToolName,
          description:
            "Delegate a self-contained coding task to a subagent in an isolated Git worktree. Give it one complete task and receive a summary.",
          plugins: [
            codingTools,
            ...(safety === undefined ? [] : [safety]),
            webTools,
            ...models.delegation,
          ],
          layer: subagentRuntime,
          policy: { maxTotalSteps: 25 },
        }),
      ]).pipe(Layer.provide(SessionJournalFs(path.join(options.root, ".roop", "sessions"))))
    }),
  ).pipe(Layer.provide(toolLayers), Layer.provide(executionLayer), Layer.provide(platformLayers))

  return HttpRouter.serve(AgentRpcServerHttp("/rpc").pipe(Layer.provide(agent))).pipe(
    Layer.provide(
      NodeHttpServer.layer(process.getBuiltinModule("node:http").createServer, {
        port: options.port,
        host: options.host ?? "127.0.0.1",
      }),
    ),
    Layer.provide(platformLayers),
  )
}
