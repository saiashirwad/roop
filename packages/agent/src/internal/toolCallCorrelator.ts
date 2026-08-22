import { Option } from "effect"

type ProviderCall = { readonly id: string; readonly token: string }

export interface ToolCallCorrelator {
  readonly allocateToken: (name: string) => string
  readonly observeProviderCall: (call: {
    readonly id: string
    readonly name: string
    readonly providerExecuted?: boolean | undefined
    readonly isKnownTool: boolean
  }) => Option.Option<string>
  readonly tokenForProviderId: (id: string) => Option.Option<string>
}

export const makeToolCallCorrelator = (options: {
  readonly sessionId: string
  readonly turn: number
  readonly step: number
}): ToolCallCorrelator => {
  let tokenSequence = 0
  const pendingTokensByName = new Map<string, Array<string>>()
  const pendingProviderCallsByName = new Map<string, Array<ProviderCall>>()
  const providerIdToToken = new Map<string, string>()
  const token = (name: string) =>
    `${options.sessionId}:${options.turn}:${options.step}:${name}:${++tokenSequence}`

  return {
    allocateToken: (name) => {
      const pendingCalls = pendingProviderCallsByName.get(name)
      if (pendingCalls !== undefined && pendingCalls.length > 0) {
        const call = pendingCalls.shift()!
        return call.token
      }
      const localToken = token(name)
      const tokens = pendingTokensByName.get(name) ?? []
      tokens.push(localToken)
      pendingTokensByName.set(name, tokens)
      return localToken
    },
    observeProviderCall: (call) => {
      if (call.providerExecuted === true || !call.isKnownTool) return Option.none()
      const pendingTokens = pendingTokensByName.get(call.name)
      if (pendingTokens !== undefined && pendingTokens.length > 0) {
        const localToken = pendingTokens.shift()!
        providerIdToToken.set(call.id, localToken)
        return Option.some(localToken)
      }
      const localToken = token(call.name)
      providerIdToToken.set(call.id, localToken)
      const calls = pendingProviderCallsByName.get(call.name) ?? []
      calls.push({ id: call.id, token: localToken })
      pendingProviderCallsByName.set(call.name, calls)
      return Option.some(localToken)
    },
    tokenForProviderId: (id) => Option.fromNullishOr(providerIdToToken.get(id)),
  }
}
