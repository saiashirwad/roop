import { Error as AgentError, Journal, RunEvent, RunPolicy, ToolRegistry } from "@roop/agent"
import { Schema } from "effect"
import { AiError } from "effect/unstable/ai"
import { Rpc, RpcGroup } from "effect/unstable/rpc"

import { RunNotFound, SendOutcome, SessionBusy } from "./RunSupervisor.ts"

const {
  JournalEmptyAppend,
  JournalFutureVersion,
  JournalRevisionConflict,
  JournalSnapshotSchema,
  JournalError,
  SessionSummarySchema,
} = Journal
const { FinalizationError, UnsafeModelRetry, ModelTimeout } = AgentError
const { InvalidToolName, ToolConflict } = ToolRegistry
const { RunEvent: RunEventSchema } = RunEvent
const { RunPolicy: RunPolicySchema } = RunPolicy

/** Session metadata a client attaches to a run. */
export const SessionMeta = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
})
export type SessionMeta = typeof SessionMeta.Type

/** The small transport contract for the host supervisor. */
export const AgentRpc = RpcGroup.make(
  Rpc.make("StartRun", {
    payload: {
      prompt: Schema.String,
      sessionId: Schema.String,
      policy: Schema.optionalKey(RunPolicySchema),
      meta: Schema.optionalKey(SessionMeta),
    },
    success: RunEventSchema,
    error: Schema.Union([
      SessionBusy,
      RunNotFound,
      AiError.AiError,
      JournalError,
      JournalRevisionConflict,
      JournalEmptyAppend,
      JournalFutureVersion,
      FinalizationError,
      InvalidToolName,
      ToolConflict,
      UnsafeModelRetry,
      ModelTimeout,
    ]),
    stream: true,
  }),
  Rpc.make("SubscribeRun", {
    payload: { sessionId: Schema.String },
    success: RunEventSchema,
    error: Schema.Union([
      SessionBusy,
      RunNotFound,
      AiError.AiError,
      JournalError,
      JournalRevisionConflict,
      JournalEmptyAppend,
      JournalFutureVersion,
      FinalizationError,
      InvalidToolName,
      ToolConflict,
      UnsafeModelRetry,
      ModelTimeout,
    ]),
    stream: true,
  }),
  Rpc.make("SendMessage", {
    payload: { sessionId: Schema.String, content: Schema.String },
    success: SendOutcome,
    error: Schema.Union([
      SessionBusy,
      JournalError,
      JournalRevisionConflict,
      JournalEmptyAppend,
      JournalFutureVersion,
    ]),
  }),
  Rpc.make("InterruptRun", {
    payload: { sessionId: Schema.String },
    success: Schema.Void,
    error: RunNotFound,
  }),
  Rpc.make("GetHistory", {
    payload: { sessionId: Schema.String },
    success: JournalSnapshotSchema,
    error: Schema.Union([JournalError, JournalFutureVersion]),
  }),
  Rpc.make("ListSessions", {
    success: Schema.Array(SessionSummarySchema),
    error: JournalError,
  }),
  Rpc.make("DeleteSession", {
    payload: { sessionId: Schema.String },
    success: Schema.Void,
    error: Schema.Union([SessionBusy, JournalError]),
  }),
)
