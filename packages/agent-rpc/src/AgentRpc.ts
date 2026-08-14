import { RunNotFound, SessionBusy } from "@roop/agent/Agent.ts"
import { AgentEvent } from "@roop/agent/AgentEvent.ts"
import { Capabilities } from "@roop/agent/Capabilities.ts"
import { ModelNotFound } from "@roop/agent/ModelCatalog.ts"
import { Session, SessionMeta, SessionNotFound } from "@roop/agent/SessionStore.ts"
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"

export const AgentRpc = RpcGroup.make(
  Rpc.make("Capabilities", {
    success: Capabilities,
  }),
  Rpc.make("Prompt", {
    payload: {
      prompt: Schema.String,
      sessionId: Schema.optionalKey(Schema.String),
      modelId: Schema.optionalKey(Schema.String),
      maxTurns: Schema.optionalKey(Schema.Number),
    },
    success: AgentEvent,
    error: Schema.Union([ModelNotFound, SessionBusy]),
    stream: true,
  }),
  Rpc.make("Interrupt", {
    payload: {
      sessionId: Schema.String,
    },
    success: Schema.Void,
    error: RunNotFound,
  }),
  Rpc.make("GetHistory", {
    payload: {
      sessionId: Schema.String,
    },
    success: Session,
    error: SessionNotFound,
  }),
  Rpc.make("ListSessions", {
    success: Schema.Array(SessionMeta),
  }),
)
