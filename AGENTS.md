To answer any Effect-related questions refer to ./.repos/effect/ (gitignored; `pnpm install` fetches
it via `scripts/prepare-effect.sh`)

Module naming: PascalCase for modules exporting an Effect service/tag or schema namespace
(SessionStore.ts, Agent.ts); camelCase for leaf pure-function helpers (agentLoop.ts, agentTool.ts).

packages/agent is the portable kernel — it may import only `effect` and `effect/unstable/ai`
(enforced by test/portability.test.ts; proven by the workerd suite in test-workerd/). Platform
wiring lives in packages/coding-harness today (it wires @effect/platform-node itself); a dedicated
adapter package returns with issue D (ExecutionWorld). packages/coding-harness is the example:
coding tools + a CLI that talks to the agent over Effect RPC (server + client modes).

All patches/ entries are load-bearing; do not remove the patchedDependencies wiring in
pnpm-workspace.yaml. @effect__ai-openai-compat: DeepSeek's chat-completions API rejects consecutive
tool calls unless they are coalesced into one assistant message and content-less assistant messages
are dropped. @texoport__effect-ai-claude / -codex: the published dists target effect beta.104, whose
part schemas made timestamp/request/response optional; beta.97 requires those keys present, so the
patches add them as undefined in the encoded part helpers.
