import type { AgentEvent } from "./AgentEvent.ts"

export type SubagentEvent = Extract<AgentEvent, { readonly _tag: "Subagent" }>

type ProviderCall = {
  readonly id: string
  readonly order: number
}

export interface ToolCallCorrelator {
  /** Allocate a unique invocation token when a local tool handler begins. */
  readonly allocateToken: (name: string) => string
  /** Observe a provider-emitted tool-call part. */
  readonly observeProviderCall: (call: {
    readonly id: string
    readonly name: string
    readonly providerExecuted?: boolean | undefined
    readonly isKnownTool: boolean
  }) => void
  /** Staged a subagent event emitted under a specific invocation token. */
  readonly stageSubagent: (token: string, event: SubagentEvent) => void
  /** Drain staged subagent events grouped by provider parent-call order. */
  readonly drainSubagentEvents: () => ReadonlyArray<AgentEvent>
}

export const makeToolCallCorrelator = (options: {
  readonly sessionId: string
  readonly turn: number
  readonly step: number
}): ToolCallCorrelator => {
  let tokenSequence = 0
  let providerSequence = 0
  const pendingTokensByName = new Map<string, Array<string>>()
  const pendingProviderCallsByName = new Map<string, Array<ProviderCall>>()
  const tokenToProviderCall = new Map<string, ProviderCall>()
  const stagedSubagents: Array<{ readonly token: string; readonly event: SubagentEvent }> = []

  return {
    allocateToken: (name: string): string => {
      const token = `${options.sessionId}:${options.turn}:${options.step}:${name}:${++tokenSequence}`
      const pendingCalls = pendingProviderCallsByName.get(name)
      if (pendingCalls !== undefined && pendingCalls.length > 0) {
        const call = pendingCalls.shift()!
        tokenToProviderCall.set(token, call)
      } else {
        const tokens = pendingTokensByName.get(name) ?? []
        tokens.push(token)
        pendingTokensByName.set(name, tokens)
      }
      return token
    },

    observeProviderCall: (call) => {
      if (call.providerExecuted === true || !call.isKnownTool) return

      const providerCall: ProviderCall = {
        id: call.id,
        order: ++providerSequence,
      }
      const pendingTokens = pendingTokensByName.get(call.name)
      if (pendingTokens !== undefined && pendingTokens.length > 0) {
        const token = pendingTokens.shift()!
        tokenToProviderCall.set(token, providerCall)
      } else {
        const calls = pendingProviderCallsByName.get(call.name) ?? []
        calls.push(providerCall)
        pendingProviderCallsByName.set(call.name, calls)
      }
    },

    stageSubagent: (token: string, event: SubagentEvent) => {
      stagedSubagents.push({ token, event })
    },

    drainSubagentEvents: (): ReadonlyArray<AgentEvent> =>
      stagedSubagents
        .map((staged, stageOrder) => ({
          staged,
          stageOrder,
          call: tokenToProviderCall.get(staged.token),
        }))
        .sort(
          (left, right) =>
            (left.call?.order ?? Number.POSITIVE_INFINITY) -
              (right.call?.order ?? Number.POSITIVE_INFINITY) || left.stageOrder - right.stageOrder,
        )
        .map(({ staged, call }) => {
          const { toolCallId: _token, ...event } = staged.event
          return call === undefined ? event : { ...event, toolCallId: call.id }
        }),
  }
}
