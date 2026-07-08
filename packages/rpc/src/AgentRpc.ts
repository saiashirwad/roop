import { RunNotFound } from "@roop/core/Agent.ts"
import { AgentCapabilitiesSchema, RunModelSettingsSchema } from "@roop/core/AgentCapabilities.ts"
import { AgentEventSchema } from "@roop/core/AgentEvent.ts"
import {
  SessionNotFound,
  SessionRecordSchema,
  SessionSchema,
  SessionSummarySchema,
} from "@roop/core/SessionStore.ts"
import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"

export const AgentRpc = RpcGroup.make(
  Rpc.make("RunPrompt", {
    payload: {
      prompt: Schema.String,
      sessionId: Schema.optionalKey(Schema.String),
      /** Catalog id (e.g. `kimi/k2p7`); omit for process default. */
      modelId: Schema.optionalKey(Schema.String),
      /** Effort / thinking overrides when the model advertises them. */
      settings: Schema.optionalKey(RunModelSettingsSchema),
    },
    success: AgentEventSchema,
    stream: true,
  }),
  Rpc.make("Interrupt", {
    payload: {
      runId: Schema.String,
    },
    success: Schema.Void,
    error: RunNotFound,
  }),
  Rpc.make("ListCapabilities", {
    success: AgentCapabilitiesSchema,
  }),
  Rpc.make("ListSessions", {
    success: SessionSummarySchema,
    stream: true,
  }),
  Rpc.make("GetSession", {
    payload: {
      sessionId: Schema.String,
    },
    success: SessionSchema,
    error: SessionNotFound,
  }),
  Rpc.make("SearchSessions", {
    payload: {
      query: Schema.String,
    },
    success: SessionSummarySchema,
    stream: true,
  }),
  /** Replay after `afterRecordId` (if set), then stream live appends. */
  Rpc.make("SubscribeSession", {
    payload: {
      sessionId: Schema.String,
      /** Exclusive cursor: replay after this id, then live. */
      afterRecordId: Schema.optionalKey(Schema.String),
    },
    success: SessionRecordSchema,
    error: SessionNotFound,
    stream: true,
  }),
)
