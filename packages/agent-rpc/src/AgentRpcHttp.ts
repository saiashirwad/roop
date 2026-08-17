import { Layer } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import type * as HttpRouter from "effect/unstable/http/HttpRouter"
import { RpcClient, RpcSerialization, RpcServer } from "effect/unstable/rpc"

import { AgentRpc } from "./AgentRpc.ts"
import { AgentRpcServer } from "./AgentRpcServer.ts"

export const AgentRpcServerHttp = (path: HttpRouter.PathInput) =>
  RpcServer.layerHttp({ group: AgentRpc, path, protocol: "http" }).pipe(
    Layer.provideMerge(RpcSerialization.layerNdjson),
    Layer.provide(AgentRpcServer),
  )

export const AgentRpcClientHttp = (url: string) =>
  RpcClient.layerProtocolHttp({ url }).pipe(
    Layer.provideMerge([FetchHttpClient.layer, RpcSerialization.layerNdjson]),
  )
