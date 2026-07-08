import { Context } from "effect"
import type { RpcClient, RpcClientError } from "effect/unstable/rpc"

import type { AgentRpc } from "./AgentRpc.ts"

export type AgentClientService = RpcClient.FromGroup<typeof AgentRpc, RpcClientError.RpcClientError>

export class AgentClient extends Context.Service<AgentClient, AgentClientService>()(
  "roop/AgentClient",
) {}
