import { RunNotFound, SessionBusy } from "@roop/agent/Agent.ts"
import { AgentEvent } from "@roop/agent/AgentEvents.ts"
import { Capabilities } from "@roop/agent/Capabilities.ts"
import { ModelNotFound } from "@roop/agent/ModelCatalog.ts"
import { RunError } from "@roop/agent/RunError.ts"
import { RunPolicy } from "@roop/agent/RunPolicy.ts"
import {
  Session,
  SessionAlreadyExists,
  SessionFormatError,
  SessionIoError,
  SessionMeta,
  SessionNotFound,
} from "@roop/agent/SessionJournal.ts"
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
      policy: Schema.optionalKey(RunPolicy),
    },
    success: AgentEvent,
    error: Schema.Union([ModelNotFound, SessionBusy, SessionFormatError, SessionIoError, RunError]),
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
    error: Schema.Union([SessionNotFound, SessionFormatError, SessionIoError]),
  }),
  Rpc.make("ListSessions", {
    success: Schema.Array(SessionMeta),
    error: SessionIoError,
  }),
  Rpc.make("ForkSession", {
    payload: {
      fromSessionId: Schema.String,
      toSessionId: Schema.optionalKey(Schema.String),
    },
    success: SessionMeta,
    error: Schema.Union([
      SessionNotFound,
      SessionFormatError,
      SessionAlreadyExists,
      SessionIoError,
    ]),
  }),
)
