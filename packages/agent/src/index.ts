/* oxlint-disable typescript/no-namespace -- exports namespace types alongside value implementations for compatibility. */

import * as JournalBase from "./Journal.ts"
import { JournalMemory as memory, JournalMemoryLive as memoryLive } from "./JournalMemory.ts"

export * as Agent from "./Agent.ts"
export { AgentEvent, type SubagentEvent } from "./AgentEvents.ts"
export type { AgentResult, ToolCallSummary, ToolResultSummary } from "./AgentResult.ts"
export type { AgentSession, SessionRunOptions } from "./AgentSession.ts"
export type { Capability, CapabilityOptions } from "./Capability.ts"
export * as DomainIds from "./DomainIds.ts"

export namespace Journal {
  export type Revision = JournalBase.Revision
  export type JournalSnapshot = JournalBase.JournalSnapshot
  export type JournalSnapshotEncoded = JournalBase.JournalSnapshotEncoded
  export type JournalError = JournalBase.JournalError
  export type JournalRevisionConflict = JournalBase.JournalRevisionConflict
  export type JournalConflict = JournalBase.JournalRevisionConflict
  export type JournalEmptyAppend = JournalBase.JournalEmptyAppend
  export type JournalFutureVersion = JournalBase.JournalFutureVersion
  export type JournalAppendError = JournalBase.JournalAppendError
  export type JournalLoadError = JournalBase.JournalLoadError
  export type JournalService = JournalBase.JournalService
  export type Journal = JournalBase.Journal
}

export const Journal = {
  ...JournalBase,
  memory,
  memoryLive,
}

export { Roop } from "./Roop.ts"
export * as RunPolicy from "./RunPolicy.ts"
export { ToolExecutionContext } from "./ToolExecutionContext.ts"
export * as AgentContext from "./AgentContext.ts"
export * as AgentEvents from "./AgentEvents.ts"
export * as AgentPlan from "./AgentPlan.ts"
export * as CryptoWeb from "./cryptoWeb.ts"
export * as Error from "./Error.ts"
export * as Event from "./Event.ts"
export * as History from "./History.ts"
export * as JournalMemory from "./JournalMemory.ts"
export * as Middleware from "./Middleware.ts"
export * as Module from "./Module.ts"
export * as Runtime from "./Runtime.ts"
export * as Testing from "./Testing.ts"
export * as ToolRegistry from "./ToolRegistry.ts"
