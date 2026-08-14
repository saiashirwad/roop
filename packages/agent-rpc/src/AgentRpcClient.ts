import { Context } from "effect"
import type { RpcClient, RpcClientError } from "effect/unstable/rpc"

import type { AgentRpc } from "./AgentRpc.ts"

export type AgentClientService = RpcClient.FromGroup<typeof AgentRpc, RpcClientError.RpcClientError>

export class AgentRpcClient extends Context.Service<AgentRpcClient, AgentClientService>()(
  "roop/AgentRpcClient",
) {}
