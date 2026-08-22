import {
  AgentEvents,
  Error as AgentError,
  Journal,
  RunError,
  RunPolicy,
  ToolRegistry,
} from "@roop/agent"
import { Schema } from "effect"
import { AiError } from "effect/unstable/ai"
import { Rpc, RpcGroup } from "effect/unstable/rpc"

import { RunNotFound, SessionBusy } from "./RunSupervisor.ts"

const {
  JournalEmptyAppend,
  JournalFutureVersion,
  JournalRevisionConflict,
  JournalSnapshotSchema,
  JournalError,
} = Journal
const { FinalizationError } = AgentError
const { InvalidToolName, ToolConflict } = ToolRegistry
const { AgentEvent } = AgentEvents
const { RunError: RunErrorSchema } = RunError
const { RunPolicy: RunPolicySchema } = RunPolicy

/** The small transport contract for the host supervisor. */
export const AgentRpc = RpcGroup.make(
  Rpc.make("StartRun", {
    payload: {
      prompt: Schema.String,
      sessionId: Schema.String,
      policy: Schema.optionalKey(RunPolicySchema),
    },
    success: AgentEvent,
    error: Schema.Union([
      SessionBusy,
      RunNotFound,
      AiError.AiError,
      RunErrorSchema,
      JournalError,
      JournalRevisionConflict,
      JournalEmptyAppend,
      JournalFutureVersion,
      FinalizationError,
      InvalidToolName,
      ToolConflict,
    ]),
    stream: true,
  }),
  Rpc.make("SubscribeRun", {
    payload: { sessionId: Schema.String },
    success: AgentEvent,
    error: Schema.Union([
      SessionBusy,
      RunNotFound,
      AiError.AiError,
      RunErrorSchema,
      JournalError,
      JournalRevisionConflict,
      JournalEmptyAppend,
      JournalFutureVersion,
      FinalizationError,
      InvalidToolName,
      ToolConflict,
    ]),
    stream: true,
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
)
