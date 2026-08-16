To answer any Effect-related questions refer to ./.repos/effect/ (gitignored; `pnpm install` fetches
it via `scripts/prepare-effect.sh`)

Module naming: PascalCase for modules exporting an Effect service/tag or schema namespace
(SessionJournal.ts, Agent.ts); camelCase for leaf pure-function helpers (agentLoop.ts,
agentTool.ts).

packages/agent is the portable kernel — it may import only `effect` and `effect/unstable/ai`
(enforced by test/portability.test.ts; proven by the workerd suite in test-workerd/).

Capability seams follow a strict three-role discipline:

1. Definition: Context.Service tag/shape (e.g. `ExecutionWorld`, `SessionJournal`).
2. Consumer: Tools and handlers declare the service in `dependencies` and yield it at runtime (e.g.
   `CodingTools` depends on `ExecutionWorld`).
3. Provider: Composition layers provide the capability (e.g. `ExecutionWorld.layer` + Node platform
   layers, Git worktree layers, or in-memory test mocks). This guarantees that swapping execution
   environments (Node, subagent worktrees, remote sandboxes) is an atomic 1-line layer swap.
   packages/coding-harness is the example: coding tools + a CLI that talks to the agent over Effect
   RPC (server + client modes).

All patches/ entries are load-bearing; do not remove the patchedDependencies wiring in
pnpm-workspace.yaml. @effect__ai-openai-compat: DeepSeek's chat-completions API rejects consecutive
tool calls unless they are coalesced into one assistant message and content-less assistant messages
are dropped. @texoport__effect-ai-claude / -codex: the published dists target effect beta.104, whose
part schemas made timestamp/request/response optional; beta.97 requires those keys present, so the
patches add them as undefined in the encoded part helpers.
